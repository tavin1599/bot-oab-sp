// index.js — BOT OAB TJSP (UPGRADE FINAL)
// Requisitos:
// npm i telegraf playwright node-cache dotenv
// npx playwright install chromium

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { chromium } = require('playwright');
const NodeCache = require('node-cache');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN não encontrado no .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);
// ========== CONFIG =============
const HEADLESS = true; // invisível
const RESULTS_PER_PAGE = 25;
const NAV_TIMEOUT = 35000;
const MAX_TOTAL_TIME_MS = 420000; // 7 minutos
const SEND_MARGIN_MS = 5000;
const CACHE_TTL = 60 * 10;
const HUMAN_MIN = 250;
const HUMAN_MAX = 850;

const cache = new NodeCache({ stdTTL: CACHE_TTL });

let browser = null;
const processingUsers = new Set();
const paginationState = new Map();

// ========== util ===========
const delay = ms => new Promise(r => setTimeout(r, ms));
const humanDelay = async () => {
  const ms = Math.floor(Math.random() * (HUMAN_MAX - HUMAN_MIN + 1)) + HUMAN_MIN;
  await delay(ms);
};

async function ensureBrowser() {
  if (browser) return browser;

  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-position=-2000,-2000' // escondido total
    ]
  });

  console.log('🎯 Playwright iniciado — janela completamente invisível');
  return browser;
}

async function newHumanContext() {
  await ensureBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });

  return ctx;
}

// ========== buscar lista (apenas hrefs) ==========
async function buscarListaPorOAB(oab) {
  const cacheKey = `list_${oab}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const ctx = await newHumanContext();
  const page = await ctx.newPage();

  try {
    console.log(`🌐 Abrindo CPOPG para OAB ${oab}...`);

    await page.goto('https://esaj.tjsp.jus.br/cpopg/open.do', {
  waitUntil: 'domcontentloaded',
  timeout: NAV_TIMEOUT
});

// 👇 ADICIONA AQUI
console.log('📄 HTML:', await page.content());
    await humanDelay();

    await page.selectOption('#cbPesquisa', 'NUMOAB').catch(()=>{});
    await humanDelay();

    await page.fill('#campo_NUMOAB', oab).catch(()=>{});
    await humanDelay();

    const btn = await page.$('#botaoConsultarProcessos');
    if (btn) await btn.click().catch(()=>{});
    else await page.click('button[type="submit"]').catch(()=>{});

    await page.waitForLoadState('networkidle').catch(()=>{});
    await humanDelay();

    const lista = await page.evaluate(() => {
      const arr = [];
      const nodes = document.querySelectorAll('a.linkProcesso, a[href*="show.do"]');
      nodes.forEach(a => {
        const txt = (a.textContent || '').trim();
        const href = a.href || a.getAttribute('href') || '';
        if (txt && href) arr.push({ numero: txt, href });
      });
      return arr;
    });

    await page.close();
    await ctx.close();

    cache.set(cacheKey, lista);
    return lista;

  } catch (err) {
    console.error('❌ Erro buscarListaPorOAB:', err);
    try { await page.close(); } catch(e){}
    try { await ctx.close(); } catch(e){}
    return [];
  }
}

// ========== extrair detalhes ==========
async function extrairDetalhesPorHref(href) {
  const defaultOut = {
    numero: '-',
    link: href || '-',
    vara: '-',
    autores: [],
    reus: [],
    advogadosMap: {},
    assunto: '-',
    valor: '-'
  };

  if (!href) return defaultOut;

  const ctx = await newHumanContext();
  const page = await ctx.newPage();

  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await humanDelay();

    const vara = await page.$eval('#varaProcesso', el => el.textContent.trim()).catch(()=>null);
    const assunto = await page.$eval('#assuntoProcesso', el => el.textContent.trim()).catch(()=>null);
    const valor = await page.$eval('#valorAcaoProcesso', el => el.textContent.trim()).catch(()=>null);

    const partes = await page.evaluate(() => {
      const out = [];
      const tds = Array.from(document.querySelectorAll('td.nomeParteEAdvogado'));

      tds.forEach(td => {
        const html = td.innerHTML || '';
        const beforeBr = (html.split(/<br\s*\/?>/i)[0] || '')
          .replace(/<\/?[^>]+>/g,'')
          .trim();

        const parteName = beforeBr || (td.textContent || '').trim();

        const advs = [];
        const advNodes = Array.from(td.querySelectorAll('*')).filter(n =>
          /Advogado/i.test(n.textContent || '')
        );

        if (advNodes.length) {
          advNodes.forEach(node => {
            let cand = '';
            if (node.nextSibling && node.nextSibling.nodeType === Node.TEXT_NODE)
              cand = node.nextSibling.textContent;
            else if (node.nextElementSibling)
              cand = node.nextElementSibling.textContent;

            cand = (cand || '')
              .replace(/[:\n\r\t]/g,'')
              .trim();

            if (cand) advs.push(cand);
          });
        }

        out.push({ parteName: parteName.trim(), advs });
      });

      return out;
    });

    const autores = [];
    const reus = [];
    const advMap = {};

    if (partes.length) {
      if (partes[0]) {
        autores.push(partes[0].parteName);
        advMap[partes[0].parteName] = partes[0].advs;
      }
      if (partes[1]) {
        reus.push(partes[1].parteName);
        advMap[partes[1].parteName] = partes[1].advs;
      }
    }

    const numero = await page.$eval(
      'span.numeroProcesso, .numeroProcesso, #numeroProcesso',
      el => el.textContent.trim()
    ).catch(async () => {
      const body = await page.evaluate(() => document.body.innerText);
      const m = body.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
      return m ? m[0] : '-';
    });

    await page.close();
    await ctx.close();

    return {
      numero,
      link: href,
      vara: vara || '-',
      autores: autores.length ? autores : ['-'],
      reus: reus.length ? reus : ['-'],
      advogadosMap: advMap,
      assunto: assunto || '-',
      valor: valor || '-'
    };

  } catch (err) {
    console.error('❌ Erro extrairDetalhesPorHref:', err);
    try { await page.close(); } catch(e){}
    try { await ctx.close(); } catch(e){}
    return defaultOut;
  }
}
function gerarPDFAlvara(d) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync('./pdfs')) fs.mkdirSync('./pdfs');

      const nome = `alvara-${d.numero.replace(/\D/g, '')}.pdf`;
      const caminho = path.join(__dirname, 'pdfs', nome);

      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const stream = fs.createWriteStream(caminho);
      doc.pipe(stream);

      // IMAGEM BASE (MODELO DO TJ)
      doc.image(
        path.join(__dirname, 'pdfs', 'modelo-alvara.png'),
        0,
        0,
        { width: 595, height: 842 }
      );

      doc.fillColor('#000');
      doc.fontSize(11);

      // REQUERENTE
      doc.text(`Reqte: ${d.autores.join(', ')}`, 90, 280);

      // CPF/CNPJ (não temos no site)
      doc.text(`CPF-CNPJ: ---`, 90, 300);

      // NÚMERO DO PROCESSO
      doc.text(`Processo Nº: ${d.numero}`, 90, 330);

      // PARTE CONTRÁRIA
      doc.text(
        `CUMPRIMENTO DE SENTENÇA CONTRA: ${d.reus.join(', ')}`,
        90,
        360,
        { width: 420 }
      );

      // VALOR
      doc.text(`Valor a receber: ${d.valor}`, 90, 420);

      // TEXTO FIXO
      doc.text(
        'O valor a receber será depositado em uma conta corrente de sua titularidade indicada no ato da liberação.',
        90,
        450,
        { width: 420 }
      );

      // DATA
      const dataHoje = new Date().toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric'
      });

      doc.text(dataHoje, 90, 520);

      doc.end();

      stream.on('finish', () => resolve(caminho));
      stream.on('error', reject);

    } catch (e) {
      reject(e);
    }
  });
}


// ========== fluxo da consulta ==========
async function startQueryForUser(userId, oab, ctx) {
  if (processingUsers.has(userId)) {
    await ctx.reply('⏳ Já estou processando sua solicitação. Aguarde.');
    return;
  }
  
  processingUsers.add(userId);

  try {
    const links = await buscarListaPorOAB(oab);

    if (!links || links.length === 0) {
      await ctx.reply(`❌ Nenhum processo encontrado para OAB ${oab}.`);
      processingUsers.delete(userId);
      return;
    }

    paginationState.set(userId, {
      links,
      processed: [],
      nextLinkIndex: 0
    });

    const startTime = Date.now();
    const st = paginationState.get(userId);

    while (st.processed.length < RESULTS_PER_PAGE && st.nextLinkIndex < st.links.length) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= (MAX_TOTAL_TIME_MS - SEND_MARGIN_MS)) break;

      const linkObj = st.links[st.nextLinkIndex];
      const det = await extrairDetalhesPorHref(linkObj.href);

      // FILTRO: só processos com número no valor
      if (!det.valor || !/\d+/.test(det.valor)) {
        console.log(`⚠ Processo ${det.numero} ignorado — valor sem números.`);
        st.nextLinkIndex++;
        continue;
      }

      st.processed.push(det);
      st.nextLinkIndex++;
      await humanDelay();
    }

    paginationState.set(userId, st);
    await sendResultsPageFromState(ctx, userId);

  } catch (err) {
    console.error('❌ startQueryForUser erro:', err);
    await ctx.reply('❌ Erro ao processar sua consulta.');
  } finally {
    processingUsers.delete(userId);
  }
}

// ========== envio ==========

async function sendResultsPageFromState(ctx, userId) {
  const st = paginationState.get(userId);
  if (!st) {
    await ctx.reply('ℹ️ Nenhuma consulta pendente.');
    return;
  }

  st.sentUpTo = st.sentUpTo || 0;

  const toSend = st.processed.slice(
    st.sentUpTo,
    Math.min(st.sentUpTo + RESULTS_PER_PAGE, st.processed.length)
  );

  for (let i = 0; i < toSend.length; i++) {
    const idx = st.sentUpTo + i;
    const p = toSend[i];

    const authorsBlock = p.autores.map(a => `- ${a}`).join('\n') || '-';
    const reusBlock = p.reus.map(r => `- ${r}`).join('\n') || '-';

    let advLines = [];
    for (const parteName of Object.keys(p.advogadosMap)) {
      const arr = p.advogadosMap[parteName];
      if (arr && arr.length) {
        advLines.push(`• ${parteName}:\n  ${arr.map(a=>`- ${a}`).join('\n')}`);
      }
    }

    const advBlock = advLines.length ? advLines.join('\n') : '-';

    const texto =
      `📄 *${idx + 1}. ${p.numero}*\n` +
      `🔗 ${p.link}\n\n` +
      `🏛 *Vara:* ${p.vara}\n\n` +
      `👤 *Autor(es):*\n${authorsBlock}\n\n` +
      `🧾 *Réu(s):*\n${reusBlock}\n\n` +
      `💼 *Advogado(s):*\n${advBlock}\n\n` +
      `📚 *Assunto:* ${p.assunto}\n` +
      `💰 *Valor:* ${p.valor}\n`;

    await ctx.reply(texto, { parse_mode: 'Markdown' });
    try {
  const pdf = await gerarPDFAlvara(p);

  await ctx.replyWithDocument({
    source: pdf,
    filename: `alvara-${p.numero.replace(/\D/g, '')}.pdf`

  });

} catch (err) {
  await ctx.reply('⚠️ Erro ao gerar o alvará.');
}
    await humanDelay();
  }

  st.sentUpTo += toSend.length;

  if (st.sentUpTo >= st.processed.length && st.nextLinkIndex < st.links.length) {
    await ctx.reply(
      `📌 Foram enviados ${st.sentUpTo}. Restam *${st.links.length - st.sentUpTo}*. Digite *continuar*.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (st.sentUpTo >= st.links.length) {
    await ctx.reply(`✅ Todos os processos foram enviados!`);
    paginationState.delete(userId);
  }
}

// ========== continuar ==========
async function handleContinue(ctx, userId) {
  if (!paginationState.has(userId)) {
    await ctx.reply('ℹ️ Nenhuma consulta pendente.');
    return;
  }

  if (processingUsers.has(userId)) {
    await ctx.reply('⏳ Já estou processando.');
    return;
  }

  processingUsers.add(userId);

  try {
    const st = paginationState.get(userId);
    const startTime = Date.now();

    while ((st.processed.length - (st.sentUpTo || 0)) < RESULTS_PER_PAGE &&
           st.nextLinkIndex < st.links.length) {
      
      const elapsed = Date.now() - startTime;
      if (elapsed >= (MAX_TOTAL_TIME_MS - SEND_MARGIN_MS)) break;

      const linkObj = st.links[st.nextLinkIndex];
      const det = await extrairDetalhesPorHref(linkObj.href);

      // FILTRO novamente
      if (!det.valor || !/\d+/.test(det.valor)) {
        console.log(`⚠ Processo ${det.numero} ignorado — valor sem números.`);
        st.nextLinkIndex++;
        continue;
      }

      st.processed.push(det);
      st.nextLinkIndex++;
      await humanDelay();
    }

    paginationState.set(userId, st);
    await sendResultsPageFromState(ctx, userId);

  } catch (err) {
    console.error('❌ handleContinue erro:', err);
    await ctx.reply('❌ Erro ao processar continuação.');
  } finally {
    processingUsers.delete(userId);
  }
}

// ========== Telegram ==========

bot.start(ctx => ctx.reply('👋 Envie a OAB (somente números). Ex: 376056'));

bot.command('oab', async ctx => {
  const arg = (ctx.message.text.split(' ')[1] || '');
  const oab = arg.replace(/\D/g,'');

  if (!/^\d{6,8}$/.test(oab))
    return ctx.reply('❌ Formato inválido. Use: /oab 376056');

  const userId = ctx.from.id;

  if (processingUsers.has(userId))
    return ctx.reply('⏳ Já estou processando.');

  await ctx.reply(`🔍 Consultando OAB ${oab}...`);
  startQueryForUser(userId, oab, ctx);
});

bot.on('text', async ctx => {
  const text = ctx.message.text.trim().toLowerCase();
  const userId = ctx.from.id;

  if (text === 'continuar')
    return handleContinue(ctx, userId);

  const onlyDigits = text.replace(/\D/g,'');

  if (/^\d{6,8}$/.test(onlyDigits)) {
    if (processingUsers.has(userId))
      return ctx.reply('⏳ Já estou processando.');

    await ctx.reply(`🔍 Consultando OAB ${onlyDigits}...`);
    return startQueryForUser(userId, onlyDigits, ctx);
  }
});

process.on('SIGINT', async () => {
  try { if (browser) await browser.close(); } catch(e){}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch(e){}
  process.exit(0);
});

// 🚀 INICIA O BOT AQUI (ÚNICO LUGAR)
(async () => {
  await bot.telegram.deleteWebhook();
  await bot.launch();
  console.log("🤖 Bot rodando 100%");
})();
