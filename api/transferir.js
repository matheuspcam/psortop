// "Copia e cola" entre aparelhos (pedido do médico, 29/09/2026): cola um texto no celular e pega no computador.
// Guarda UM texto no Upstash Redis, que se apaga sozinho em 30 minutos (ou antes, no botão "Apagar").
// Usa as mesmas variáveis do banco das sugestões: KV_REST_API_URL e KV_REST_API_TOKEN.

const CHAVE = 'ortopia:transferir';
const VALIDADE_SEGUNDOS = 30 * 60;
const MAX_CHARS = 20000;

async function upstash(comando) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Banco de dados não configurado no servidor.');
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  const data = await resposta.json();
  if (!resposta.ok || data.error) throw new Error(data.error || 'Erro ao acessar o banco de dados.');
  return data.result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  const { pin, acao, texto } = req.body || {};
  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) return res.status(401).json({ erro: 'PIN incorreto' });

  try {
    if (acao === 'enviar') {
      const t = String(texto || '').slice(0, MAX_CHARS);
      if (!t.trim()) return res.status(400).json({ erro: 'Cole um texto antes de enviar.' });
      await upstash(['SET', CHAVE, JSON.stringify({ texto: t, data: new Date().toISOString() }), 'EX', String(VALIDADE_SEGUNDOS)]);
      return res.status(200).json({ ok: true });
    }
    if (acao === 'apagar') {
      await upstash(['DEL', CHAVE]);
      return res.status(200).json({ ok: true });
    }
    // receber
    const bruto = await upstash(['GET', CHAVE]);
    if (!bruto) return res.status(200).json({ texto: '', data: '' });
    const item = JSON.parse(bruto);
    return res.status(200).json({ texto: item.texto || '', data: item.data || '' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: e.message || 'Falha no copia e cola.' });
  }
}
