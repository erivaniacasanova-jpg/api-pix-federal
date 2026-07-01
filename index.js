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
        // Inicializa o navegador em background para ambientes Linux (Railway)
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
        
        // Configura o tamanho da janela simulada para evitar quebras de layout
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 1. Acessa a página inicial de boletos
        await page.goto('https://federalassociados.com.br/boletos', { waitUntil: 'networkidle2', timeout: 30000 });
        
        // 2. Limpa o campo e garante o preenchimento correto do CPF por conta da máscara do site
        await page.waitForSelector('input', { timeout: 5000 });
        
        // Garante que o CPF use apenas números para não chocar com a máscara visual
        const cpfLimpo = cpf.replace(/\D/g, '');
        
        await page.evaluate(() => {
            const input = document.querySelector('input');
            if (input) {
                input.value = '';
                input.focus();
            }
        });
        
        // Digita simulando o teclado humano
        await page.type('input', cpfLimpo, { delay: 100 });
        
        // 3. Localiza e clica exatamente no botão "Consultar" pelo texto interno dele
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
        
        // Pausa estratégica de 4 segundos: Aguarda o site processar o AJAX e montar a tabela na tela
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // 4. Localiza o botão "Pagar" dentro do resultado carregado
        const botoesPagar = await page.$$('button, a, .btn-success');
        let btnPagar = null;

        for (const b of botoesPagar) {
            const texto = await page.evaluate(el => el.textContent, b);
            if (texto.includes('Pagar')) {
                btnPagar = b;
                break;
            }
        }

        if (!btnPagar) {
            throw new Error('Nenhuma fatura pendente localizada para este CPF após a consulta.');
        }

        // Clica no botão Pagar para abrir o Modal de opções
        await btnPagar.click();

        // 5. Aguarda o Modal carregar na tela
        await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa para animação de abertura do modal
        
        const elementosModal = await page.$$('button, a, div, h3');
        let btnPix = null;

        for (const el of elementosModal) {
            const texto = await page.evaluate(el => el.textContent, el);
            if (texto.includes('Ver QR Code') || texto.includes('Pix')) {
                btnPix = el;
                break;
            }
        }

        if (!btnPix) {
            throw new Error('Opção de pagamento Pix não encontrada no painel.');
        }

        await btnPix.click();
        
        // 6. Aguarda a janela com o código Pix Copia e Cola aparecer e extrai o valor
        await page.waitForSelector('textarea, input, p', { timeout: 7000 });
        
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
