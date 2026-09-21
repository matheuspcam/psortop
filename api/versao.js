// Informa quando foi feito o último upload para o GitHub que está no ar (commit publicado pela Vercel).
// Usa as variáveis de sistema da Vercel (VERCEL_GIT_*). Se o repositório for privado,
// crie na Vercel a variável GITHUB_TOKEN (token só de leitura) para a data aparecer.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  const { pin } = req.body || {};
  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }

  const dono = process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.VERCEL_GIT_REPO_SLUG;
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const mensagem = process.env.VERCEL_GIT_COMMIT_MESSAGE || '';
  if (!dono || !repo || !sha) {
    return res.status(200).json({ data: null, sha: null, mensagem: '', aviso: 'Variáveis da Vercel indisponíveis.' });
  }

  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'ortopia' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${dono}/${repo}/commits/${sha}`, { headers });
    if (!r.ok) {
      return res.status(200).json({ data: null, sha: sha.slice(0, 7), mensagem, aviso: 'Repositório privado: crie GITHUB_TOKEN na Vercel para mostrar a data.' });
    }
    const c = await r.json();
    const data = (c.commit && (c.commit.committer || c.commit.author) || {}).date || null;
    return res.status(200).json({ data, sha: sha.slice(0, 7), mensagem });
  } catch (e) {
    return res.status(200).json({ data: null, sha: sha.slice(0, 7), mensagem, aviso: 'Não foi possível consultar o GitHub.' });
  }
}
