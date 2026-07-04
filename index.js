const express = require('express');
// Trocamos 'puppeteer' puro por 'puppeteer-extra' + plugin stealth.
// O stealth corrige os sinais que entregam que é um Chrome automatizado
// (navigator.webdriver, WebGL vendor, plugins ausentes, etc.), que é
// provavelmente o motivo do Cloudflare/anti-fraude do site estar
// devolvendo respostas vazias pro robô mesmo com CPF válido.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const app = express();

app.use(express.json());

// Guarda o último screenshot em memória, pra dar pra ver via /debug-screenshot
let ultimoScreenshot = null;
let ultimoHtmlDump = null;

app.get('/debug-screenshot', (req, res) => {
    if (!ultimoScreenshot) {
        return res.status(404).send('Nenhum screenshot capturado ainda.');
    }
    res.set('Content-Type', 'image/png');
    res.send(ultimoScreenshot);
});

app.get('/debug-html', (req, res) => {
    if (!ultimoHtmlDump) {
        return res.status(404).send('Nenhum HTML capturado ainda.');
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(ultimoHtmlDump);
});

// Espera até que uma função retorne true, testando a cada 300ms, com timeout total.
// Substitui os "setTimeout fixos" do script original, que erram cedo demais
// quando o AJAX do site demora mais que o previsto.
async function esperarCondicao(page, fnBrowser, { timeout = 15000, intervalo = 300 } = {}) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeout) {
        const ok = await page.evaluate(fnBrowser).catch(() => false);
        if (ok) return true;
        await new Promise(r => setTimeout(r, intervalo));
    }
    return false;
}

app.post('/obter-pix', async (req, res) => {
    const { cpf } = req.body;

    if (!cpf) {
        return res.status(400).json({ sucesso: false, erro: "CPF não fornecido no corpo da requisição." });
    }

    console.log(`[API] Iniciando busca para o CPF: ${cpf}`);

    let browser;
    let page;

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        });

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // networkidle2 espera o site "assentar" (poucas conexões de rede ativas),
        // mais seguro que domcontentloaded pra sites com JS que monta a página depois.
        await page.goto('https://federalassociados.com.br/boletos', { waitUntil: 'networkidle2', timeout: 45000 });

        // Checagem de sanidade: confirma que realmente chegamos na página real
        // (e não numa interstitial do Cloudflare / página de desafio).
        // Se isso falhar, o problema é bloqueio anti-bot, não o fluxo de cliques.
        const paginaReal = await page.evaluate(() => {
            return document.body.innerText.toUpperCase().includes('CONSULTA DE SITUAÇÃO DE ASSOCIADOS');
        });

        if (!paginaReal) {
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('A página carregada não parece ser o site real (possível bloqueio Cloudflare/anti-bot). Veja /debug-screenshot.');
        }

        // 2. Preenche o CPF
        await page.waitForSelector('input', { timeout: 10000 });
        const cpfLimpo = cpf.replace(/\D/g, '');

        await page.evaluate(() => {
            const input = document.querySelector('input');
            if (input) {
                input.value = '';
                input.focus();
            }
        });

        await page.type('input', cpfLimpo, { delay: 100 });

        // 3. Clica no botão "Consultar"
        const clicouConsultar = await page.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('button, input[type="submit"], .btn, a'));
            const btn = botoes.find(el => el.textContent.trim().includes('Consultar'));
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        if (!clicouConsultar) {
            throw new Error('Botão "Consultar" não foi localizado na página.');
        }

        // 4. Espera ATIVAMENTE o botão "PAGAR" aparecer (em vez de sleep fixo de 6s).
        // Isso corrige o erro mais comum: o AJAX do site demorando mais que o esperado
        // e o robô concluindo (errado) que não existe fatura pendente.
        const apareceuPagar = await esperarCondicao(page, () => {
            const elementos = Array.from(document.querySelectorAll('button, a, .btn, td'));
            return elementos.some(el => el.textContent.toUpperCase().includes('PAGAR'));
        }, { timeout: 20000 });

        if (!apareceuPagar) {
            // Salva screenshot + HTML pra você poder inspecionar via /debug-screenshot e /debug-html
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('Nenhuma fatura pendente localizada para este CPF após a consulta (ou a tabela demorou mais que 20s pra carregar — veja /debug-screenshot).');
        }

        const btnPagarHandle = await page.evaluateHandle(() => {
            const elementos = Array.from(document.querySelectorAll('button, a, .btn, td'));
            return elementos.find(el => el.textContent.toUpperCase().includes('PAGAR'));
        });

        const btnPagar = btnPagarHandle.asElement();
        if (!btnPagar) {
            throw new Error('Botão "PAGAR" desapareceu antes do clique.');
        }

        await btnPagar.click();

        // 5. Espera o modal de pagamento abrir
        await page.waitForSelector('.card-corpo', { timeout: 8000 });

        // Localiza especificamente o CARD DO PIX (não o primeiro '.card-corpo', que é o Boleto).
        // O modal tem 3 cards: Boleto, Cartão, Pix — nessa ordem no DOM.
        const cardPixHandle = await page.evaluateHandle(() => {
            const cards = Array.from(document.querySelectorAll('.card-corpo'));
            return cards.find(c => c.textContent.toUpperCase().includes('PIX'));
        });
        const cardPix = cardPixHandle.asElement();

        if (!cardPix) {
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('Card do Pix não foi encontrado no modal (veja /debug-screenshot).');
        }

        await cardPix.click();
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 6. Clica especificamente em "Gerar Pix" (não no primeiro botão qualquer do card)
        const clicouGerarPix = await page.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('a, button, .btn'));
            const btn = botoes.find(el => el.textContent.toUpperCase().includes('GERAR') && el.textContent.toUpperCase().includes('PIX'));
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        if (!clicouGerarPix) {
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('Botão "Gerar Pix" não foi encontrado (veja /debug-screenshot).');
        }

        // O site pode levar alguns segundos pra gerar o Pix, então esperamos ativamente
        // pelo botão "Ver QrCode" em vez de assumir que já está pronto.
        await esperarCondicao(page, () => {
            const elementos = Array.from(document.querySelectorAll('a, button, .btn'));
            return elementos.some(el => el.textContent.toUpperCase().includes('QRCODE') || el.textContent.toUpperCase().includes('QR CODE'));
        }, { timeout: 15000 });

        const clicouVerQrCode = await page.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('a, button, .btn'));
            const btn = botoes.find(el => el.textContent.toUpperCase().replace(/\s/g, '').includes('QRCODE'));
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        if (!clicouVerQrCode) {
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('Botão "Ver QrCode" não foi encontrado (veja /debug-screenshot).');
        }

        // 7. Espera ativamente o código Pix aparecer (em vez de sleep fixo)
        await esperarCondicao(page, () => {
            const alvos = document.querySelectorAll('textarea, input, p, div');
            for (const item of alvos) {
                const valor = item.value || item.textContent || '';
                if (valor.trim().startsWith('000201')) return true;
            }
            return false;
        }, { timeout: 15000 });

        const copiaECola = await page.evaluate(() => {
            const alvos = document.querySelectorAll('textarea, input, p, div');
            for (const item of alvos) {
                const valor = item.value || item.textContent || '';
                if (valor.trim().startsWith('000201')) {
                    return valor.trim();
                }
            }
            return null;
        });

        if (!copiaECola) {
            ultimoScreenshot = await page.screenshot();
            ultimoHtmlDump = await page.content();
            throw new Error('O código Pix não foi gerado ou o formato mudou (veja /debug-screenshot e /debug-html).');
        }

        console.log(`[API] Pix extraído com sucesso para o CPF: ${cpf}`);
        return res.json({ sucesso: true, pix: copiaECola });

    } catch (erro) {
        console.error(`[API] Erro no processamento: ${erro.message}`);
        return res.status(500).json({ sucesso: false, erro: erro.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor de Automação ativo na porta ${PORT}`));
