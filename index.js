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

    // Inicializa o navegador com os argumentos necessários para rodar em VPS/Hospedagem Linux
    const browser = await puppeteer.launch({
        headless: true,
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
    
    // Configura o tamanho da janela simulada para não quebrar layouts responsivos
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        // 1. Acessa a página inicial de boletos
        await page.goto('https://federalassociados.com.br/boletos', { waitUntil: 'networkidle2', timeout: 30000 });
        
        // 2. Preenche o CPF
        await page.waitForSelector('input', { timeout: 5000 });
        await page.type('input', cpf, { delay: 50 });
        
        // 3. Clica em Consultar
        await page.click('button.btn-success, input[type="submit"], .btn');
        
        // Aguarda a resposta do servidor e a nova renderização da tabela
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
        
        // 4. Localiza o botão "Pagar" dentro da tabela de faturas
        await page.waitForSelector('button, a', { timeout: 5000 });
        const botoes = await page.$$('button, a');
        let btnPagar = null;

        for (const b of botoes) {
            const texto = await page.evaluate(el => el.textContent, b);
            if (texto.includes('Pagar')) {
                btnPagar = b;
                break;
            }
        }

        if (!btnPagar) {
            throw new Error('Nenhuma fatura pendente localizada para este CPF.');
        }

        // Clica no botão Pagar para abrir o Modal de opções
        await btnPagar.click();

        // 5. Aguarda o Modal carregar e clica na opção do Pix
        await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa preventiva para animações do modal
        
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
            throw new Error('O código Pix não foi gerado ou o seletor mudou.');
        }

        console.log(`[API] Pix extraído com sucesso para o CPF: ${cpf}`);
        return res.json({ sucesso: true, pix: copiaECola });

    } catch (erro) {
        console.error(`[API] Erro no processamento: ${erro.message}`);
        return res.status(500).json({ sucesso: false, erro: erro.message });
    } finally {
        await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Automação ativo na porta ${PORT}`));