const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.post('/obter-pix', async (req, res) => {
    const { cpf } = req.body;
    
    if (!cpf) {
        return res.status(400).json({ sucesso: false, erro: "CPF não fornecido no corpo da requisição." });
    }

    console.log(`[API] Iniciando busca para o CPF: ${cpf}`);

    let browser;
    
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

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // CORREÇÃO CRÍTICA: ignora scripts infinitos de background e aguarda apenas o HTML estrutural carregar
        await page.goto('https://federalassociados.com.br/boletos', { waitUntil: 'domcontentloaded', timeout: 45000 });
        
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
        
        // Pausa para garantir que o AJAX da tabela carregue
        await new Promise(resolve => setTimeout(resolve, 6000));
        
        // 4. Localiza o botão "Pagar"
        const btnPagarHandle = await page.evaluateHandle(() => {
            const elementos = Array.from(document.querySelectorAll('button, a, .btn, td'));
            return elementos.find(el => el.textContent.toUpperCase().includes('PAGAR'));
        });

        const btnPagar = btnPagarHandle.asElement();

        if (!btnPagar) {
            throw new Error('Nenhuma fatura pendente localizada para este CPF após a consulta.');
        }

        // Clica no botão Pagar para abrir o modal
        await btnPagar.click();

        // 5. Interação com o Card do modal
        await page.waitForSelector('.card-corpo', { timeout: 8000 });
        await page.click('.card-corpo');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Seleciona o botão interno do QR Code dentro do card ativo
        const btnPix = await page.evaluateHandle(() => {
            const card = document.querySelector('.card-corpo');
            if (!card) return null;
            return card.querySelector('a, button, .btn');
        });

        const elementoFinal = btnPix.asElement();

        if (!elementoFinal) {
            throw new Error('Elemento de clique do QR Code não foi encontrado dentro do card.');
        }

        await page.evaluate(el => el.click(), elementoFinal);
        
        // 6. Extrai o código Pix Copia e Cola
        await page.waitForSelector('textarea, input, p', { timeout: 10000 });
        
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
            throw new Error('O código Pix não foi gerado ou o formato mudou.');
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
