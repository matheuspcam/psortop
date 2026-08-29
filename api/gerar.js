export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  const { pin, tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante, modo, dataHoje, imagens, resultadoAnterior, instrucaoAjuste, categoria, exemplos, pedido, tipoAtestado, diasAfastamento, diagnosticoAtestado } = req.body;

  if (!process.env.SITE_PIN || pin !== process.env.SITE_PIN) {
    return res.status(401).json({ erro: 'PIN incorreto' });
  }

  const ehAvulso = modo === 'avulso';

  if (!ehAvulso && !template) {
    return res.status(400).json({ erro: 'Falta o template selecionado' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: 'Chave da API não configurada no servidor' });
  }

  const ehAjuste = !!(resultadoAnterior && instrucaoAjuste);
  const ehMensagem = modo === 'mensagem';

  const promptSistema = ehAjuste
    ? montarPromptSistemaAjuste()
    : (ehAvulso
      ? montarPromptSistemaAvulso()
      : (ehMensagem ? montarPromptSistemaMensagem() : montarPromptSistema()));

  const contents = ehAjuste
    ? [
        { role: 'user', parts: [{ text: `TEXTO ATUAL (gerado anteriormente):\n\n${resultadoAnterior}` }] },
        { role: 'model', parts: [{ text: 'Entendido. Esse é o texto atual. Aguardando a instrução de ajuste.' }] },
        { role: 'user', parts: [{ text: `INSTRUÇÃO DE AJUSTE (aplique literalmente, é uma ordem direta do médico, não uma sugestão a ser avaliada):\n\n${instrucaoAjuste}` }] }
      ]
    : [{ role: 'user', parts: montarParts(
        ehAvulso
          ? montarPromptAvulso({ categoria, exemplos, pedido, tipoAtestado, diasAfastamento, diagnosticoAtestado })
          : (ehMensagem
            ? montarPromptMensagem({ dadosCaso, template, dataHoje })
            : montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante })),
        imagens
      ) }];

  try {
    let texto = await chamarGemini(promptSistema, contents, ehAjuste ? 0.5 : 0.3, apiKey, res);
    if (texto === null) return; // erro já respondido dentro de chamarGemini

    // Proteção extra: se o ajuste devolveu o texto praticamente idêntico ao anterior,
    // a instrução foi ignorada. Tenta uma segunda vez com uma instrução ainda mais enfática.
    if (ehAjuste && textoQuaseIgual(texto, resultadoAnterior)) {
      const contentsReforcado = [
        { role: 'user', parts: [{ text: `TEXTO ATUAL (gerado anteriormente):\n\n${resultadoAnterior}` }] },
        { role: 'model', parts: [{ text: 'Entendido. Esse é o texto atual. Aguardando a instrução de ajuste.' }] },
        { role: 'user', parts: [{ text: `INSTRUÇÃO DE AJUSTE (aplique literalmente, é uma ordem direta do médico, não uma sugestão a ser avaliada):\n\n${instrucaoAjuste}` }] },
        { role: 'model', parts: [{ text: texto }] },
        { role: 'user', parts: [{ text: 'Você devolveu o texto praticamente sem nenhuma alteração. Isso é um erro — releia a instrução de ajuste acima com atenção e aplique a mudança pedida de verdade, editando o texto onde for necessário. Devolva agora o texto corrigido.' }] }
      ];
      const textoRetry = await chamarGemini(promptSistema, contentsReforcado, 0.6, apiKey, res, true);
      if (textoRetry !== null) texto = textoRetry;
    }

    return res.status(200).json({ texto: texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Falha ao gerar o texto. Tente novamente.' });
  }
}

// Normaliza e compara dois textos para detectar se o "ajuste" na prática não mudou nada relevante.
function textoQuaseIgual(a, b) {
  function normalizar(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  const na = normalizar(a);
  const nb = normalizar(b);
  if (na === nb) return true;
  // diferença muito pequena (poucos caracteres) tambem conta como "nao mudou nada relevante"
  const diff = Math.abs(na.length - nb.length);
  return diff < 5 && na.slice(0, 50) === nb.slice(0, 50);
}

async function chamarGemini(promptSistema, contents, temperature, apiKey, res, silencioso) {
  const resposta = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: promptSistema }] },
        contents: contents,
        generationConfig: { temperature: temperature }
      })
    }
  );

  const data = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro da API Gemini:', JSON.stringify(data));
    if (!silencioso) {
      const detalhe = data?.error?.message ? ` (${data.error.message})` : '';
      res.status(502).json({ erro: `Erro ao gerar o texto${detalhe}` });
    }
    return null;
  }

  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) {
    if (!silencioso) {
      res.status(502).json({ erro: 'Resposta vazia do modelo. Tente novamente.' });
    }
    return null;
  }

  return texto;
}

function montarPromptSistema() {
  return `Você é um assistente médico especializado em ortopedia em pronto-socorro, com foco em documentação clínica de alto nível técnico, clareza, objetividade e segurança médico-legal.
Sua função é estruturar prontuários médicos completos, com linguagem técnica, concisa, direta e adequada para registro hospitalar.

REGRAS GERAIS:
- Linguagem médica formal
- Evitar redundâncias
- Frases curtas e objetivas
- Não usar termos vagos
- Sempre incluir elementos de segurança médico-legal quando aplicável
- Não inventar dados clínicos — trabalhar apenas com o que for fornecido
- Corrigir automaticamente pequenos erros de digitação ou abreviações informais de nomes de dispositivos, órteses e materiais quando o termo pretendido for claro pelo contexto (ex: "robfoot" ou "robo foot" devem ser escritos como "robofoot"; "buddy tape" como "buddy taping"). Nunca troque o termo por outro dispositivo diferente do que foi mencionado — corrija apenas a grafia
- Os dados que o médico envia podem estar corridos, diretos, picotados ou informais — sua função é organizar, corrigir e adequar ao padrão do template, nunca replicar o estilo de escrita recebido

REGRA CRÍTICA — DENSIDADE E QUALIDADE DA HISTÓRIA (HDA/HPMA):
"Objetivo e direto" não significa "raso" ou "telegráfico". Quando o médico fornece vários dados sobre o caso (mecanismo do trauma, contexto, tentativas de tratamento prévias, evolução, o que já foi feito), a história deve refletir essa riqueza de informação, e não apenas listar os dados soltos em sequência. Para isso:
- Conecte os fatos com nexo clínico e temporal (use conectivos como "evoluindo com", "há X dias, seguido de", "sem melhora apesar de", "motivo pelo qual") em vez de justapor frases curtas desconexas
- Se o médico informou que já tentou algo (medicação, fisioterapia, repouso) sem melhora, isso é informação relevante para a história — inclua isso de forma articulada, não como frase solta
- Não elimine informação clínica relevante fornecida pelo médico só para deixar a frase mais curta. Prefira uma frase um pouco mais longa e completa a três frases picotadas que perdem a conexão entre os fatos
- O "EM TEMPO" (resumo de exames de imagem) deve ser um resumo médico substantivo dos achados relevantes — nem uma cópia extensa do laudo, nem uma frase genérica de uma linha que omite achados importantes. Inclua os achados que mudam conduta ou geram dúvida diagnóstica, resumidos com linguagem própria

REGRA CRÍTICA — COERÊNCIA CLÍNICA ENTRE DIAGNÓSTICO E EXAME FÍSICO:
Sempre que um diagnóstico (ou suspeita diagnóstica) for mencionado em qualquer parte dos dados fornecidos — nos "dados do caso", na história, ou em qualquer campo — o exame físico descrito deve ser clinicamente compatível com esse diagnóstico, e não apenas mencionar o diagnóstico solto na história sem nenhum reflexo no exame. Para isso, ao redigir o exame físico:
- Garanta que a localização da dor/queixa (topografia, lado D/E) condiz com a região esperada para aquele diagnóstico
- Inclua, quando plausível para o quadro e não contradiga dados fornecidos, achados gerais compatíveis: presença ou ausência de edema/derrame, limitação de amplitude de movimento, dor à palpação ou à mobilização da região envolvida
- NÃO invente testes especiais, manobras nomeadas (ex: Neer, Hawkins, Lachman, Thessaly) ou sinais muito específicos que o médico não tenha informado — mantenha os achados em nível geral e plausível, nunca detalhado a ponto de parecer um exame que não foi realmente feito
- Se o médico já descreveu o exame físico com detalhe, NUNCA contradiga ou substitua o que foi informado — esta regra vale apenas para preencher lacunas de coerência quando o exame físico fornecido for vago ou omisso em relação ao diagnóstico citado
- Isso vale para qualquer diagnóstico mencionado, esteja ele associado a um template específico ou citado livremente no texto

REGRA CRÍTICA — QUANDO OS DADOS FORNECIDOS FOREM ESCASSOS, NUNCA DESCARACTERIZE O QUADRO DO TEMPLATE:
O médico às vezes seleciona um template específico (ex: Torcicolo Agudo, Fascite Plantar, Manguito Rotador) e fornece poucos dados no caso — às vezes só o essencial ou nada além da confirmação do quadro. Isso NUNCA é motivo para gerar uma HDA e um exame físico genéricos, dissociados do diagnóstico do template selecionado. Nesses casos:
- O nome/diagnóstico do template escolhido pelo médico já é, em si, uma informação clínica dada — use-o como base para a queixa principal e para os achados de exame físico típicos daquele quadro, exatamente como o modelo de referência já traz (ex: no template de Torcicolo, mesmo com poucos dados, a HDA deve falar em dor cervical e o exame físico deve manter a musculatura cervical/paracervical, rotação limitada etc. — não pode virar uma queixa e um exame físico genéricos sem qualquer relação com torcicolo)
- Falta de detalhe do médico (tempo de evolução, mecanismo, lado) gera omissão ou reescrita natural APENAS daquele dado pontual (conforme a regra de fidelidade abaixo) — nunca a substituição de toda a estrutura clínica do template por um texto genérico "esvaziado"
- Sinalize no aviso (⚠️) o que faltou detalhar (ex: "⚠️ Tempo de evolução não informado"), mas o corpo do prontuário deve continuar sendo redigido dentro do padrão clínico do template selecionado, com a mesma riqueza de exame físico que o modelo já fornece
- Isso é diferente de inventar dado factual (proibido pela regra de fidelidade): usar a estrutura clínica esperada do próprio template escolhido não é invenção, é a função central do template
- Reorganizar e reformular a REDAÇÃO é sua função; alterar o CONTEÚDO factual não é. Cada fato clínico que o médico escreveu (datas, prazos, lados do corpo, mecanismo de trauma, achados, condutas, tempo de evolução, exames citados) deve aparecer no texto final exatamente como informado, apenas com a linguagem adequada ao registro médico
- Nunca troque um dado por outro parecido, nunca "arredonde" datas ou prazos, nunca mude o lado (D/E) informado, nunca substitua um achado por outro mais "típico" do quadro
- ATENÇÃO ESPECIAL À CRONOLOGIA: quando o médico relata uma sequência de eventos (ex: "trauma há X dias" + "sem dor atualmente" + "fez tal procedimento na ocasião" + "hoje vim reavaliar"), preserve exatamente a ordem e as relações temporais entre eles. Não inverta o que aconteceu "na ocasião do trauma" com o que está acontecendo "hoje, na reavaliação". Separe claramente, na sua leitura dos dados, o que é passado (história) do que é presente (exame físico e achados de hoje) antes de redigir
- Se o texto que o médico escreveu for ambíguo o suficiente para gerar dúvida real sobre o fato, sinalize isso na linha de aviso no topo (⚠️) em vez de decidir sozinho qual versão usar
- Antes de finalizar, releia mentalmente os dados fornecidos pelo médico, na ordem cronológica em que os eventos aconteceram, e confira se essa mesma ordem e cada fato estão refletidos corretamente no texto gerado

REGRA CRÍTICA — O TEXTO PRECISA FAZER SENTIDO CLÍNICO SOZINHO:
O texto do prontuário será copiado e colado DIRETO em um sistema hospitalar real, na correria, SEM revisão linha a linha. Um texto fluente mas clinicamente sem sentido é PIOR que um erro visível, porque passa despercebido. Por isso:
- O texto final NUNCA pode conter colchetes, placeholders, reticências, "[a preencher]", "___", parênteses com a palavra "instrução", ou qualquer marcação indicando informação faltante
- Os modelos de referência abaixo contêm trechos entre parênteses começando com "(instrução: ...)" — esses trechos são orientações PARA VOCÊ seguir ao gerar o texto, e NUNCA devem aparecer, nem parafraseados, no resultado final. Siga a orientação e apague o parêntese inteiro do texto de saída
- Toda frase que você escrever precisa fazer sentido clínico completo por si só. NUNCA produza frases com lacunas disfarçadas — exemplos do que é PROIBIDO: "refere quadro de torcicolo há, evoluindo com..." (falta o tempo), "trauma em há 2 dias" (falta o segmento), "dor em ombro há" (falta o tempo)
- Se um dado variável específico (tempo de evolução, segmento acometido, lado D/E, mecanismo do trauma) NÃO foi informado, você tem duas opções, nesta ordem: (1) reescrever a frase de forma naturalmente completa sem aquele dado — ex: em vez de "refere trauma em tornozelo há [nada]", escreva "refere trauma em tornozelo, evoluindo com dor local desde então"; ou (2) se a frase não fizer sentido sem o dado, omitir a frase inteira, mantendo o restante coerente
- Nunca deixe uma frase pela metade, com preposição solta ("há", "em", "de") sem complemento, ou com vazio visível
- Todo e qualquer aviso sobre informação faltante, ambígua, ou assumida vai SOMENTE na linha de aviso no topo (começando com "⚠️ "), nunca dentro do corpo do prontuário

REGRA — NEGATIVAS E LINHAS PADRÃO SEMPRE PERMANECEM:
As negativas padronizadas que já constam nos modelos (ex: "Nega trauma", "Nega febre", "Nega TCE", "Nega perda ponderal", "Nega demais queixas associadas", "Nega alterações esfincterianas", "Nega outros traumas associados") são afirmações de rotina da anamnese dirigida — o médico sempre pergunta isso, e na ausência de relato em contrário elas são verdadeiras. O mesmo vale para linhas de conduta marcadas nos modelos como PADRÃO (ex: a oferta de radiografia recusada em decisão compartilhada, nos quadros crônicos). O mesmo vale também para a linha de esclarecimento médico-legal "Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces..." (em suas variações conforme o template) — ela é uma proteção médico-legal de rotina e deve sempre aparecer nos templates que a contêm, independente do que o médico informou. Por isso:
- Essas linhas SEMPRE entram no texto final, mesmo que o médico não tenha mencionado nada sobre elas
- Elas NÃO são afetadas pela regra de dados faltantes acima, porque não dependem de nenhum dado variável para fazer sentido
- Elas NÃO são afetadas por reescrita, resumo ou reorganização do texto — nunca as omita para deixar o texto mais enxuto
- Só remova ou altere uma dessas linhas se o médico informou algo que a contradiz (ex: se ele disse "refere febre", troque a linha "Nega febre" pelo achado real; se ele disse que fez o RX, substitua a linha da oferta recusada pelo achado radiográfico)

REGRAS DE USO DOS TEMPLATES:
- Os modelos fornecidos são padrões de redação, não textos para copiar cegamente
- A linha "AP:" (antecedentes pessoais) dos modelos está escrita como "nega alergias" (padrão). Sempre que o médico informar QUALQUER antecedente pessoal relevante nos dados do caso (comorbidades, cirurgias prévias, uso de medicações contínuas, acompanhamento com outro especialista, alergias, etc.), inclua essa informação na linha de AP, de forma objetiva e no padrão médico formal — nunca omita um AP informado. Se nada além de alergia for mencionado, mantenha "nega alergias". Se houver antecedente relevante E não houver menção a alergia, mantenha "nega alergias" junto com o antecedente informado (ex: "AP: nega alergias. Antecedente de meniscectomia em joelho esquerdo, em acompanhamento ambulatorial recente com ortopedia."). Este campo é frequentemente esquecido — trate-o com a mesma prioridade dada ao exame físico e à conduta
- O exame físico dos modelos está escrito no padrão "tudo normal". Sempre que for informado um achado alterado (dor, edema, deformidade, déficit, limitação etc.), substitua a linha correspondente pelo achado real. Nunca mantenha uma negativa que contradiga o que foi informado
- As linhas de CONDUTA funcionam como um menu: inclua apenas as que se aplicam ao caso informado. Não inclua imobilização, atestado, internação ou orientação de não apoio se isso não foi mencionado
- Nunca combine no mesmo texto condutas mutuamente excludentes (ex: alta ambulatorial e indicação de internação)
- PADRÃO PARA EXAME DE IMAGEM NORMAL/SEM FRATURA: em qualquer template, sempre que o médico informar que a radiografia (ou outro exame de imagem) não mostrou fratura ou alteração aguda, use exatamente esta frase no "EM TEMPO" (adaptando apenas o exame e o segmento, se for diferente de radiografia): "Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica." Nunca use uma versão resumida como "resultado normal" ou "sem alterações"

REGRA CRÍTICA — ORDEM DAS LINHAS NA CONDUTA (o que mudou primeiro, o que foi mantido depois):
Em QUALQUER template (inicial, reavaliação, crônico), a ordem das linhas dentro de CONDUTA deve seguir este critério, para facilitar a checagem rápida na correria do plantão:
1. Primeiro, se houver, a linha de abertura do tipo "sem sinais de gravidade/urgência no momento" (ou equivalente do modelo) — essa sempre fica no topo, é a frase-âncora
2. Em seguida, as condutas NOVAS ou ALTERADAS neste atendimento — ou seja, tudo que é ação/decisão tomada agora (nova solicitação de exame de imagem, nova imobilização, nova medicação prescrita, encaminhamento, internação, mudança de conduta em relação ao atendimento anterior). Dentro deste bloco, mantenha a ordem em que essas informações foram fornecidas pelo médico
3. Por último, o que é mantido/rotina/sem mudança (orientações gerais padrão, esclarecimentos médico-legais de rotina, retorno se piora, linhas padrão que sempre aparecem)
Nunca deixe uma conduta nova "perdida" no meio ou no fim do bloco de linhas de rotina — o objetivo é que o médico consiga ver o que mudou logo nas primeiras linhas após a frase de abertura.

REGRA — SEXO E IDADE SÃO APENAS CONTEXTO CLÍNICO, NUNCA APARECEM NO TEXTO:
O médico pode informar sexo e/ou idade do paciente nos dados do caso. Essa informação serve EXCLUSIVAMENTE para você calibrar o raciocínio clínico por trás da conduta — por exemplo: em criança, o limiar para imobilizar após trauma é mais baixo mesmo com radiografia sem fratura evidente, pela possibilidade de lesão fisária de difícil identificação radiográfica; em idoso, considerar fragilidade óssea e risco de fratura por baixa energia. Use esse contexto para escolher e ajustar as condutas apropriadas.
PROIBIDO: escrever a idade, o sexo, ou qualquer referência a eles no texto final do prontuário — nem diretamente ("paciente de 8 anos", "paciente do sexo feminino"), nem indiretamente ("a criança", "o idoso", "a paciente"). Use sempre "paciente", de forma neutra.

ESTRUTURA:
Siga EXATAMENTE o modelo de referência fornecido (inclusive estilo, maiúsculas, divisões e organização).

ESTILO DE SAÍDA:
- Alta densidade informativa
- Padrão de prontuário hospitalar
- Direto ao ponto
- OBRIGATÓRIO: cada frase deve começar em uma NOVA LINHA. Nunca junte duas frases na mesma linha formando um parágrafo corrido. Sempre que uma frase termina com ponto final, a próxima frase começa em uma linha nova. Isso vale especialmente dentro de blocos como EXAME FÍSICO e CONDUTA, onde cada achado ou conduta ocupa sua própria linha
- OBRIGATÓRIO: deixe uma linha em branco entre cada seção do prontuário (ex: entre "HDA:" e "EXAME FÍSICO:", entre "EXAME FÍSICO:" e "EM TEMPO:" ou "CONDUTA:"). Dentro de uma mesma seção, as linhas ficam uma embaixo da outra sem linha em branco entre elas — o espaço em branco é só entre uma seção e a próxima

Se for reavaliação, mantenha coerência com o atendimento inicial informado e destaque a evolução em relação ao quadro inicial.

FORMATO DA RESPOSTA:
Se precisar sinalizar algo faltante, ambíguo ou assumido, coloque isso em uma ou mais linhas no topo. CADA linha de aviso deve começar EXATAMENTE com "⚠️ " (esse emoji e um espaço, sem a palavra "ATENÇÃO" nem dois-pontos), seguida direto de um rótulo curtíssimo — 2 a 6 palavras, sem verbo, sem explicação (ex: "⚠️ Dados insuficientes", "⚠️ Nome da equipe não informado"). Se fizer sentido, inclua também uma linha curta de sugestão de melhoria no mesmo formato (ex: "⚠️ Sugestão: informar o segmento acometido"). Prefira várias linhas curtíssimas a uma linha longa. Depois de todos os avisos, deixe uma linha em branco, e então o texto do prontuário — já completo, corrido e pronto para copiar, sem nenhuma lacuna. Se não houver nada a sinalizar, não escreva nenhuma linha de aviso — vá direto para o texto do prontuário.`;
}

const TEMPLATES = {
  a: {
    nome: '1º Atendimento',
    texto: `AP: nega alergias

QD:

EXAME FÍSICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Indolor à palpação.
Sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Solicito radiografias
Reavaliação após (o médico informa o prazo/momento — ex: resultado de exame, algumas horas, retorno ainda neste plantão; nunca assuma um número de dias)`
  },
  b: {
    nome: 'Trauma (Anamnese 1 Etapa)',
    texto: `AP: nega alergias.

HDA: Paciente refere trauma em (instrução: cite o mecanismo e o segmento informados — ex: "trauma torcional em tornozelo", "trauma direto em joelho", "queda com apoio de mão") (instrução: lado D/E se informado) há (instrução: tempo informado), evoluindo com dor local (instrução: acrescente edema, dificuldade para deambular/mobilizar, ou outros sintomas associados se informados) desde então.
Nega outros traumas associados.
Nega outras queixas relevantes no momento.

EXAME FÍSICO:
Paciente em bom estado geral, lúcido e orientado. (Instrução: se o toggle "relatado por acompanhante" estiver marcado, adicione aqui: "História relatada pelo acompanhante." Se o paciente for identificado como criança ou idoso e o toggle estiver marcado, mantenha a linguagem de exame física igual, apenas ajustando o sujeito da HDA para refletir que o relato veio do acompanhante, não do próprio paciente.)
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles. (Instrução: se houver edema informado, substitua esta linha citando a topografia — ex: "Edema em topografia de tornozelo lateral".)
Dor à palpação (instrução: cite a estrutura/região específica informada — ex: "ligamento talofibular anterior", "interlinha articular do joelho", "tabaqueira anatômica", "olécrano"; se não informado, use "no segmento acometido"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
(Instrução: se o caso envolver ombro com suspeita de lesão de manguito, adicione testes específicos apenas se mencionados pelo médico — ex: "Jobe negativo", "Neer negativo", "Patte negativo", "Gerber negativo". Se envolver luxação glenoumeral reduzida, ajuste a frase de perfusão para "Após redução, reavaliado mantendo perfusão distal preservada e sem déficits neurovasculares evidentes.")

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao (instrução: "paciente" normalmente; se o toggle de acompanhante estiver marcado, pode usar "paciente e ao acompanhante") o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada. (Instrução: se o toggle de acompanhante estiver marcado, ajuste para "Paciente e acompanhante referem compreensão das orientações, encontrando-se cientes da conduta adotada.")

(Instrução: as linhas abaixo são OPCIONAIS — inclua no texto final apenas as que se aplicam ao caso informado; nunca copie esta instrução nem os colchetes para o resultado)
Forneço atestado médico
Realizada imobilização do segmento acometido com (instrução: use o tipo de imobilização informado — ex: "tala gessada suropodálica", "órtese", "tornozeleira", "tipoia" — se não informado, use "dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.
Realizada redução incruenta com sucesso. (Instrução: use esta linha apenas em casos de luxação reduzida no PS.)
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  },
  c: {
    nome: 'Liberação — RX Limpo',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, não evidenciando fraturas, luxações ou outras alterações osteoarticulares agudas, dentro das limitações e sensibilidade do método, passíveis de não identificação em fases iniciais ou em lesões de baixa expressão radiográfica.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia.
Orientado repouso relativo, evitando esforços e impacto sobre o segmento acometido até reavaliação.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica em cerca de 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento, com eventual complementação propedêutica.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, edema progressivo, limitação funcional importante, alteração de sensibilidade ou força, alteração de coloração do membro, febre ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.`
  },
  d: {
    nome: 'Liberação — Fratura',
    texto: `PSO

EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura, sem sinais de desvio significativo ou instabilidade evidente ao método, passível de tratamento incruento conforme padrão atual. (Instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido")

CONDUTA:
Sem indicação de procedimento ortopédico cirúrgico de urgência no momento.
Prescrita analgesia para controle álgico, associada a orientações gerais e crioterapia, se possível.
Orientado seguimento ambulatorial com ortopedia, com reavaliação clínica e radiográfica em 10 dias para acompanhamento evolutivo e reavaliação da conduta instituída.
Explicado ao paciente o quadro atual e a conduta proposta nesta avaliação.
Esclarecido que a evolução clínica deve ser acompanhada, podendo haver necessidade de reavaliação conforme resposta ao tratamento e evolução do quadro, inclusive com possibilidade de mudança de conduta conforme evolução.
Esclarecido que a avaliação inicial, inclusive por métodos de imagem, pode não evidenciar todas as lesões em fases precoces ou de baixa expressão, não afastando completamente a possibilidade de lesões associadas, sendo fundamental o acompanhamento evolutivo, com reavaliação clínica e eventual complementação propedêutica conforme evolução do quadro.
Orientado quanto a sinais de alarme e necessidade de retorno imediato em caso de piora da dor, aumento importante do edema, piora da limitação funcional, alteração de sensibilidade, alteração de força, mudança de coloração do membro, dor desproporcional ou outras intercorrências.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Forneço atestado médico
Realizada imobilização do segmento acometido (instrução: use o tipo de imobilização informado pelo médico; se não informado, use "com dispositivo de imobilização adequado ao segmento"), em posição funcional, sem intercorrências imediatas.
Orientado repouso, com elevação do membro acometido e não apoio (NPP), com auxílio de dispositivo de marcha.`
  },
  e1: {
    nome: 'Crônico — Lombalgia Mecânica',
    texto: `AP: nega alergias.

HPMA: Paciente refere lombalgia crônica, com agudização do quadro (instrução: acrescente o tempo de agudização se informado; se não informado, não force referência temporal), com piora à mobilização (instrução: acrescente "após esforço físico" ou "sem fator desencadeante definido" apenas se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega alterações urinárias ou intestinais, retenção urinária, incontinência esfincteriana, anestesia em sela, déficit motor progressivo ou outros sinais de alarme no momento.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado, deambulando.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Dor à palpação da musculatura paravertebral lombar, sem pontos de dor focal.
Sem dor importante à palpação de proeminências ósseas.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores e inferiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
Lasègue negativo. (Instrução: incluir apenas se o médico mencionou ter testado.)
Sem sinais clínicos de mielopatia ou síndrome da cauda equina.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado retorno progressivo às atividades conforme tolerância.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, alterações de sensibilidade ou força, alterações esfincterianas, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM ambulatorialmente. (Instrução: esta linha agora é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre RM. Só remova se o médico disser explicitamente que não quer pedir RM ou que a RM não é necessária.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e2: {
    nome: 'Crônico — Cervicalgia Mecânica',
    texto: `AP: nega alergias.

HPMA: Paciente refere cervicalgia (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), com piora à mobilização (instrução: acrescente "após esforço físico" ou "sem fator desencadeante definido" apenas se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega parestesias, déficit motor, alteração esfincteriana ou outros sinais de alarme no momento.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou abaulamentos evidentes da coluna cervical.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Dor à palpação da musculatura paravertebral cervical e trapézio, sem pontos de dor focal.
Sem dor importante à palpação de proeminências ósseas.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Spurling negativo. (Instrução: incluir apenas se testado.)
Teste de distração negativo. (Instrução: incluir apenas se testado.)
Sem sinais clínicos de mielopatia.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar esforços e movimentos bruscos.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, alterações de sensibilidade ou força, dor irradiada importante, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e3: {
    nome: 'Crônico — Torcicolo Agudo',
    texto: `AP: nega alergias.

HPMA: Paciente refere dor cervical (instrução: acrescente o tempo de início se informado; se não informado, não force referência temporal), principalmente à rotação do pescoço.
Refere início ao acordar / após movimento brusco / sem trauma definido. (Instrução: escolher apenas o que foi informado; se nada foi informado, omita esta linha.)
Nega história de trauma direto.
Nega febre ou outros sinais flogísticos.
Nega parestesias, déficit motor ou outras queixas associadas.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Paciente em bom estado geral, lúcido e orientado.
Mantém atitude antálgica cervical.
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou abaulamentos evidentes.
Sem sinais flogísticos locais.
Dor à palpação de musculatura esternocleidomastoidea, trapézio e paracervical, sem pontos de dor focal.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento cervical limitada por dor, principalmente à rotação.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas em membros superiores, sem déficits neurológicos evidentes ao exame segmentar.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim).

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar movimentos bruscos.
Indicado colar cervical de espuma por curto período. (Instrução: incluir apenas se mencionado.)
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo persistência ou piora importante da dor, surgimento de sinais flogísticos, febre, irradiação relevante, déficit neurológico ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e4: {
    nome: 'Crônico — Fascite Plantar',
    texto: `AP: nega alergias.

HPMA: Paciente refere dor em região plantar do pé (instrução: lado D/E se informado), predominando em calcâneo e inserção da fáscia plantar, pior aos primeiros passos do dia e após períodos de repouso (instrução: acrescente o tempo de evolução se informado).
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem hiperemia ou sinais flogísticos importantes.
Dor à palpação da inserção da fáscia plantar no calcâneo e face plantar do retropé, sem pontos de dor focal adicionais.
Sem dor importante à palpação das demais estruturas do pé.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado alongamento de cadeia posterior e modificação temporária de atividades de impacto.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos, limitação funcional progressiva, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito USG ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame; ajuste o tipo de exame conforme informado.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e5: {
    nome: 'Crônico — Manguito Rotador / Ombralgia',
    texto: `AP: nega alergias.

HPMA: Paciente refere dor em ombro (instrução: lado D/E se informado) (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), com piora à elevação do membro e aos movimentos acima da linha do ombro.
Refere dor noturna e dificuldade para deitar sobre o lado acometido. (Instrução: incluir apenas se mencionado.)
Nega história de trauma recente.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos importantes.
Dor à palpação de região subacromial, tuberosidade maior e face lateral do ombro, sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força globalmente preservada, sem déficit motor grosseiro.
(Instrução: incluir testes especiais — Jobe, Neer, Patte, Gerber — com resultado positivo/negativo, apenas os que o médico mencionou ter realizado.)
Sem déficits sensitivos ou motores no membro.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar atividades repetitivas e movimentos acima da linha do ombro.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão das lesões de partes moles, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, perda progressiva de força, surgimento de sinais flogísticos, febre, limitação funcional importante ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM de ombro ambulatorialmente. (Instrução: incluir apenas se o médico mencionou ter solicitado exame; ajuste o tipo de exame conforme informado.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e6: {
    nome: 'Crônico — Tendinopatia (modelo genérico)',
    texto: `AP: nega alergias.

HPMA: Paciente refere dor em (instrução: local informado) (instrução: acrescente o tempo de evolução se informado; se não informado, não force referência temporal), de caráter progressivo, relacionada a esforço e movimentos repetitivos (instrução: escolher apenas o que foi informado).
Nega história de trauma agudo.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação local, com piora à mobilização do segmento e à contração resistida da estrutura acometida.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos importantes, déficit funcional progressivo, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
(Instrução: as linhas abaixo são um MENU. Inclua apenas as que o médico mencionou ter solicitado ou oferecido; não invente exames não mencionados.)
Solicito USG e entrego retorno ambulatorial após o exame.
Solicito RM ambulatorialmente.
Encaminhado para fisioterapia.
Alta da ortopedia.`
  },
  e7: {
    nome: 'Crônico — Gonalgia Não Traumática',
    texto: `AP: nega alergias.

HPMA: Paciente refere gonalgia crônica (instrução: lado D/E se informado), com agudização do quadro (instrução: acrescente o tempo se informado; se não informado, não force referência temporal), sem trauma recente.
Refere piora à deambulação, flexão, subir e descer escadas e esforço. (Instrução: citar apenas as que forem informadas; se nenhuma informada, omita esta linha.)
Nega história de trauma.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega sinais sistêmicos.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação da (instrução: interlinha articular, compartimento medial, compartimento lateral ou região patelofemoral, conforme informado; se não informado, use "articulação do joelho"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações grosseiras.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Orientado evitar sobrecarga e atividades de impacto até melhora.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica, resposta ao tratamento e investigação complementar.
Orientado quanto a sinais de alarme, incluindo piora da dor, edema importante, surgimento de sinais flogísticos, febre, incapacidade funcional progressiva ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
Solicito RM e encaminho ao ambulatório para reavaliação e seguimento. (Instrução: incluir apenas se o médico mencionou ter solicitado exame.)
Encaminhado para fisioterapia. (Instrução: incluir apenas se mencionado.)
Alta da ortopedia. (Instrução: incluir apenas se o médico deu alta.)`
  },
  e8: {
    nome: 'Crônico — Outro / Genérico',
    texto: `AP: nega alergias.

HPMA: Paciente refere quadro de (instrução: use a queixa e o segmento informados — ex: "dor em quadril direito", "dor em cotovelo esquerdo") de caráter crônico (instrução: acrescente o tempo de evolução e padrão de piora apenas se informados; se não informados, não force referência temporal).
Nega história de trauma agudo relacionado à queixa atual.
Nega febre ou outros sinais flogísticos.
Nega perda ponderal.
Nega déficit sensitivo ou motor.
Nega demais queixas associadas.

EXAME FÍSICO ORTOPÉDICO:
Sem lesões cutâneas abertas, sem escoriações ou sinais de exposição óssea.
Sem deformidades, desalinhamentos ou encurtamentos do segmento.
Sem edema, sem abaulamentos e sem tensão de partes moles.
Sem sinais flogísticos exuberantes.
Dor à palpação (instrução: cite a região/estrutura específica informada; se não informada, use "no segmento acometido"), sem pontos de dor focal adicionais.
Sem gaps palpáveis ou crepitações.
Amplitude de movimento preservada dentro dos limites da dor.
Sem bloqueios mecânicos ou instabilidade grosseira.
Força motora e sensibilidade preservadas.
Pulsos distais palpáveis e simétricos.
Perfusão periférica adequada, com tec < 3 segundos.
Sem sinais clínicos de síndrome compartimental.
Sem sinais sugestivos de lesão vascular aguda.
Sem sinais clínicos de trombose venosa profunda.
(Instrução: se o segmento for de coluna, acrescente "Reflexos patológicos ausentes (Hoffman, Clônus, Babinski e Oppenheim)."; omita essa linha para segmentos apendiculares.)

CONDUTA:
Sem indicação de procedimento ortopédico de urgência no momento.
Instituída analgesia, associada a orientações quanto a medidas físicas locais, repouso relativo e modificação temporária das atividades habituais.
Oferecida realização de radiografia nesta avaliação; em decisão compartilhada, paciente opta por não realizar o exame no momento, ciente das limitações da avaliação sem exame complementar. (Instrução: esta linha é PADRÃO e deve SEMPRE entrar no texto, mesmo que o médico não mencione nada sobre radiografia. Só altere ou remova se o médico informar que o exame FOI realizado — nesse caso, substitua pelo achado radiográfico informado.)
Esclarecido que a avaliação inicial pode não demonstrar integralmente a extensão do quadro, podendo haver necessidade de reavaliação conforme evolução clínica e resposta ao tratamento.
Orientado quanto a sinais de alarme, incluindo piora da dor, surgimento de sinais flogísticos importantes, déficit funcional progressivo, febre ou outras intercorrências, com recomendação de retorno imediato ao pronto atendimento se necessário.
Orientado seguimento ambulatorial.
Paciente refere compreensão das orientações, encontrando-se ciente da conduta adotada.
(Instrução: as linhas abaixo são um MENU. Inclua apenas as que o médico mencionou; cite exame e região coerentes com o segmento informado; não invente exames.)
Solicito exame de imagem ambulatorialmente.
Encaminhado para fisioterapia.
Alta da ortopedia.`
  },
  f: {
    nome: 'Canetada Internar',
    texto: `EM TEMPO:
Avalio radiografias do segmento acometido, evidenciando fratura (instrução: se o médico informou qual segmento/osso, cite-o aqui; se não informou, mantenha a frase genérica "do segmento acometido"), sem indicação de tratamento incruento, com necessidade de abordagem cirúrgica.

CONDUTA:
Caso encaminhado à equipe de retaguarda cirúrgica (instrução: cite o nome do hospital se informado pelo médico; se não informado, omita o nome do hospital e escreva apenas "à equipe de retaguarda cirúrgica").
Representada na presente data pela equipe (instrução: cite o nome do médico da retaguarda se informado; se não informado, omita esta frase inteira e sinalize no aviso do topo que o nome da equipe/médico não foi informado).
(Instrução: a linha abaixo — sobre discussão formal com a equipe de retaguarda — é OPCIONAL. Inclua apenas se o médico mencionar que discutiu o caso com a equipe; se ele apenas indicou internação sem mencionar discussão prévia, omita esta linha inteira e vá direto para "Indicada internação hospitalar...")
Formalmente discutido com a equipe de retaguarda, que, após análise clínica e dos exames disponíveis, indica internação hospitalar para tratamento cirúrgico como conduta definitiva.
Indicada internação hospitalar para prosseguimento do tratamento cirúrgico.
Paciente devidamente informado acerca do quadro clínico, da indicação de internação e da proposta terapêutica.
Prestados esclarecimentos quanto aos riscos inerentes ao tratamento proposto, incluindo, entre outros, dor crônica, hemorragia, deiscência de sutura, infecção, pseudoartrose, consolidação viciosa ou não consolidação, complicações clínicas intercorrentes (tais como infecções respiratórias, eventos infecciosos sistêmicos e sepse), bem como eventos adversos graves, inclusive óbito.
Paciente refere ter compreendido as informações prestadas, encontrando-se ciente e de acordo com a conduta proposta, optando por dar seguimento ao tratamento indicado.`
  },
  g: {
    nome: 'Discussão',
    texto: `CONDUTA:
Explico ao paciente e ao familiar as possíveis modalidades de tratamento, tanto cirúrgico quanto conservador, bem como os riscos e benefícios envolvidos em cada uma delas.
Oriento sobre a gravidade da fratura e suas possíveis complicações, incluindo limitação do arco de movimento, déficit funcional, dor crônica e/ou deformidade residual.
Após esclarecimentos, opta-se, neste momento, pelo tratamento conservador.
Informo ao paciente e ao familiar que o caso será encaminhado para discussão e reavaliação pela equipe do Trauma Ortopédico, que realizará contato para agendamento de uma avaliação complementar ambulatorial em breve, com o objetivo de reavaliar a lesão e definir a conduta definitiva em conjunto com o paciente e seus familiares.`
  }
};

const NOMES_TIPO = {
  inicial: 'Atendimento inicial (paciente será reavaliado depois, ainda sem desfecho)',
  reavaliacao: 'Reavaliação (de atendimento anterior, já com desfecho a definir)',
  completo: 'Atendimento completo (avaliado e resolvido nesta mesma consulta)'
};

function montarPromptUsuario({ tipoAtendimento, dadosCaso, atendimentoInicial, template, extra, acompanhante }) {
  const templatesEscolhidos = String(template)
    .split('+')
    .map(t => t.trim())
    .filter(Boolean);

  const blocosTemplate = templatesEscolhidos
    .map(t => TEMPLATES[t])
    .filter(Boolean)
    .map(t => `--- MODELO: ${t.nome} ---\n${t.texto}`)
    .join('\n\n');

  let partes = [];
  partes.push(`TIPO DE ATENDIMENTO: ${NOMES_TIPO[tipoAtendimento] || tipoAtendimento}`);

  if (acompanhante) {
    partes.push(`\nHISTÓRIA RELATADA POR ACOMPANHANTE: sim. Ajuste a redação da HDA e das linhas de esclarecimento/orientação para refletir que quem relatou os fatos e recebeu as orientações foi o acompanhante (ex: pai/mãe/responsável, no caso de criança; familiar/cuidador, no caso de idoso ou paciente impossibilitado), conforme instruções específicas já indicadas dentro dos modelos de referência.`);
  }

  if (tipoAtendimento === 'reavaliacao' && atendimentoInicial) {
    partes.push(`\nATENDIMENTO INICIAL (para contexto e coerência — destaque a evolução em relação a isto):\n${atendimentoInicial}`);
  }

  if (dadosCaso && dadosCaso.trim()) {
    partes.push(`\nDADOS DO CASO ATUAL:\n${dadosCaso}`);
  } else {
    partes.push(`\nDADOS DO CASO ATUAL: não informados. O médico optou por gerar o prontuário usando apenas o modelo padrão abaixo, sem alterações — use o texto do modelo de referência tal como está (com as negativas de rotina padrão), sem inventar achados nem deixar de gerar o texto.`);
  }

  if (extra && extra.trim()) {
    partes.push(`\nRESULTADO DE EXAME DE IMAGEM/LAUDO FORNECIDO PELO MÉDICO (obrigatório usar isto no "EM TEMPO" do prontuário — resuma os achados relevantes com linguagem própria; NUNCA ignore ou omita este conteúdo, mesmo que o modelo de referência não tenha uma seção "EM TEMPO" pronta, crie-a se necessário):\n${extra}`);
  }

  partes.push(`\nMODELO(S) DE REFERÊNCIA A SEGUIR:\n${blocosTemplate}`);

  partes.push(`\nGere o prontuário completo agora, seguindo exatamente a estrutura do(s) modelo(s) acima, adaptado aos dados fornecidos.`);

  return partes.join('\n');
}

/* ===================== MENSAGENS ===================== */

function montarPromptSistemaAjuste() {
  return `Você está EDITANDO um texto médico que já foi gerado, a pedido do Dr. Matheus, ortopedista do Hospital Sancta Maggiore (HSM) Madrid.

Você vai receber o texto atual e, em seguida, uma instrução de ajuste. Sua ÚNICA tarefa é aplicar exatamente essa instrução ao texto, e devolver o texto completo já corrigido.

REGRAS OBRIGATÓRIAS:
- A instrução do médico é uma ORDEM DIRETA e ESPECÍFICA sobre este texto — não uma sugestão, não algo a ser avaliado quanto a fazer sentido ou não. Execute o que foi pedido.
- IMPORTANTE — o médico frequentemente escreve a instrução de forma corrida, informal, abreviada ou em linguagem de fala, exatamente como faria ao te contar verbalmente o que aconteceu (ex: "ela tomou remédio e não melhorou, por isso veio"). Sua tarefa não é colar esse texto informal dentro do prontuário. Sua tarefa é EXTRAIR a informação clínica ali contida e REDIGIR essa informação com o mesmo padrão de linguagem médica, formal e objetiva, do restante do texto — a mesma transformação que você já faz ao gerar o texto pela primeira vez a partir dos dados brutos do médico.
- Se a instrução pede para adicionar uma informação: identifique o parágrafo/seção correta para ela (HDA/HPMA para história, EXAME FÍSICO para achados de exame, CONDUTA para decisões), redija-a no estilo formal do restante do texto, e insira-a de forma que a frase se conecte fluidamente com o que já existe ao redor — nunca como uma frase colada ou um apêndice solto ao final do parágrafo.
- Se a instrução pede para remover algo, remova completamente essa parte (a frase, o parágrafo ou a linha inteira, o que for necessário para a remoção fazer sentido, ajustando a frase adjacente se necessário para o texto continuar fluindo bem).
- Se a instrução pede para trocar uma palavra, expressão ou atribuição de autoria (ex: trocar "por mim" por outra coisa, trocar "paciente" por "acompanhante", mudar o lado D/E), troque exatamente onde ela aparece no texto, em todas as ocorrências relevantes.
- NUNCA ignore a instrução, nunca devolva o texto sem nenhuma alteração, e nunca devolva apenas uma cópia idêntica do texto anterior — se você fizer isso, está falhando na tarefa.
- Fora do que foi pedido na instrução, mantenha o restante do texto exatamente como estava (mesmas frases, mesma ordem, mesmo formato), incluindo a(s) linha(s) de aviso no topo começando com "⚠️", se houver, salvo se a própria instrução pedir para alterá-las.
- Devolva APENAS o texto final completo, já corrigido. Sem comentários, sem explicações, sem aspas, sem markdown, sem repetir a instrução recebida.`;
}

function montarPromptSistemaMensagem() {
  return `Você é um assistente do Dr. Matheus, ortopedista do Hospital Sancta Maggiore (HSM) Madrid, e sua função é redigir mensagens padronizadas a partir de dados brutos ou abreviados que ele envia.

REGRAS GERAIS:
- Interprete dados enviados em formato bruto, abreviado ou desorganizado, e produza a saída padronizada do modelo escolhido
- Siga EXATAMENTE o layout e o texto fixo do modelo indicado — não invente saudações, despedidas ou frases extras
- Não invente dados clínicos ou pessoais que não foram informados
- Se faltar um dado essencial de um campo de formulário (ex: matrícula, telefone, hospital de origem), deixe o rótulo do campo no lugar mas sem o valor, exatamente como uma ficha preenchida à mão com uma lacuna esquecida — nunca escreva "NÃO INFORMADO", "[a preencher]" ou qualquer marcação, e nunca invente o valor. Sinalize cada campo faltante em uma linha de aviso no topo
- A saída será copiada e colada direto no WhatsApp, então entregue apenas o texto final da mensagem, sem comentários seus antes ou depois

AVISOS:
Se algum dado essencial estiver faltando, ambíguo, ou se você tiver uma sugestão relevante (ex: terminologia anatômica mais precisa para a hipótese diagnóstica), coloque isso em uma ou mais linhas no topo, cada uma começando EXATAMENTE com "⚠️ " (esse emoji e um espaço, sem a palavra "ATENÇÃO" nem dois-pontos), seguida de um rótulo curtíssimo de 2 a 6 palavras. Depois dos avisos, deixe uma linha em branco, e então a mensagem final. Se não houver nada a sinalizar, vá direto para a mensagem.

IMPORTANTE — DIFERENÇA PARA PRONTUÁRIO:
Estas mensagens NÃO são prontuário médico. Aqui, dados como nome completo, idade, matrícula e telefone SÃO parte do conteúdo e devem aparecer normalmente quando o modelo os exigir.`;
}

const MENSAGENS = {
  chefe: {
    nome: 'Para o chefe (ficha de encaminhamento)',
    texto: `Formate os dados em CAIXA ALTA, sem saudações nem texto adicional, exatamente neste layout:

NOME COMPLETO: [nome]
MATRÍCULA: [matrícula]
IDADE: [idade]
HD: [hipótese diagnóstica]
ANTICOAGULANTE: [sim/não]
MARCAPASSO: [sim/não]
TELEFONE: [telefone]
HOSPITAL DE ORIGEM: [hospital]
OBS: [opcional, apenas quando clinicamente relevante]

REGRAS DESTE MODELO:
- Valores padrão, salvo indicação contrária do médico: ANTICOAGULANTE = NÃO, MARCAPASSO = NÃO, HOSPITAL DE ORIGEM = HSM MADRID
- Campos ausentes devem ser sinalizados explicitamente na linha de aviso do topo. No corpo da mensagem, deixe a linha com o rótulo mas sem o valor (ex: "TELEFONE: "), exatamente como ficaria se o médico tivesse esquecido de preencher à mão — nunca escreva "NÃO INFORMADO" nem invente um valor. O texto final deve parecer uma ficha preenchida manualmente com uma lacuna esquecida, não um formulário gerado por IA
- HD com precisão anatômica: inclua lateralidade (direito/esquerdo) e localização (ex: "extremidade distal", "terço proximal"). Se o médico informou de forma imprecisa, proponha a terminologia padronizada e sinalize a sugestão no aviso do topo para ele confirmar
- A linha OBS só entra quando houver algo clinicamente relevante; caso contrário, omita a linha inteira
- OBS em linguagem concisa e colegial — o destinatário é um colega conhecido, então evite tom formal ou diretivo demais
- Se houver múltiplos pacientes, gere uma ficha separada para cada um, separadas por uma linha em branco`
  },
  internacao: {
    nome: 'Solicitação de internação (informativo)',
    texto: `Use EXATAMENTE este layout, preenchendo apenas os valores. Mantenha os asteriscos do título (formatação de negrito do WhatsApp) e os nomes dos campos sem alteração:

*INFORMATIVO DE SOLICITAÇÃO DE INTERNAÇÃO*

Fluxo: [fluxo]
Paciente: [iniciais do paciente]
Matrícula: [matrícula]
Idade: [idade] anos
Diagnóstico: [diagnóstico]
Tempo de sala: [tempo de sala]
CD: [conduta]
Hospital de origem: [hospital de origem]
Transferência para Hospital: [hospital de destino]
Uso de anticoagulante/antiagregante: [Sim/Não]
Uso de marca-passo: [Sim/Não]

REGRAS DESTE MODELO:
- PACIENTE: use apenas as INICIAIS do nome, separadas por ponto e espaço (ex: "João Carlos Mendes" vira "J. C. M."). Nunca escreva o nome completo neste modelo

VALORES PADRÃO — esta é uma mensagem padronizada que o médico usa quase sempre da mesma forma. Use estes valores automaticamente, salvo indicação contrária explícita do médico nos dados enviados:
- Fluxo = URGÊNCIA FLUXO COMUM
- Tempo de sala = 2h
- CD = Internação para Tratamento Cirúrgico
- Transferência para Hospital = HSM Tailândia
- Uso de anticoagulante/antiagregante = Não
- Uso de marca-passo = Não

HOSPITAL DE ORIGEM — só pode ser um destes dois: HSM Santiago ou HSM SBC. O médico precisa informar qual dos dois. Se ele não informar, NÃO escolha um sozinho: sinalize no aviso do topo (ex: "⚠️ Hospital de origem não informado") e deixe o campo "Hospital de origem: " sem valor no corpo da mensagem.

CAMPOS QUE SEMPRE VARIAM E SÃO OBRIGATÓRIOS (Paciente, Matrícula, Idade, Diagnóstico): se o médico não informar algum destes, NÃO invente e NÃO escreva "NÃO INFORMADO" no corpo — deixe a linha com o campo e o rótulo, mas sem o valor (ex: "Matrícula: "), exatamente como ficaria se o médico tivesse esquecido de preencher à mão. Ao mesmo tempo, sinalize cada campo faltante em uma linha de aviso no topo, para o médico completar antes de enviar. O texto final deve parecer uma ficha preenchida manualmente com uma lacuna esquecida, não um formulário gerado por IA.

Diagnóstico com precisão anatômica: inclua lateralidade (direita/esquerda) e, quando houver cirurgia prévia relacionada, cite entre parênteses o procedimento e a data no formato MM/AA (ex: "infecção relacionada ao material de síntese (PO osteossíntese patela direita – 07/26)").

Se houver múltiplos pacientes, gere um informativo separado para cada um, separados por uma linha em branco e uma linha com "———".`
  },
  paciente: {
    nome: 'Para o paciente (retorno via WhatsApp)',
    texto: `Use EXATAMENTE este template, preenchendo apenas os campos variáveis e mantendo todo o restante do texto sem alteração:

Olá, aqui é o Dr. Matheus, da Ortopedia do Hospital Madrid.

Entramos em contato para informar que, após avaliação e discussão com a chefia do hospital, o(a) Sr.(a) [NOME COMPLETO] será tratado(a) de forma [CONDUTA].

Solicitamos que compareça para retorno no dia [DD/MM/AAAA] ([dia da semana]), às [horário], no Pronto-Socorro do [HOSPITAL].

Esclarecemos que a evolução clínica deverá ser acompanhada, podendo haver necessidade de reavaliação conforme a resposta ao tratamento e a evolução do quadro, inclusive com possibilidade de mudança de conduta.

Qualquer dúvida, estamos à disposição.

REGRAS DESTE MODELO:
- [NOME COMPLETO]: use o nome informado. Ajuste o tratamento e a concordância de gênero ao longo de todo o texto — "o Sr. ... será tratado" para homem, "a Sra. ... será tratada" para mulher. Não deixe as formas "o(a)", "Sr.(a)" ou "tratado(a)" no texto final: escolha a forma correta conforme o gênero. Se o gênero não for dedutível do nome, sinalize no aviso do topo e use a forma masculina
- [CONDUTA]: padrão mais comum é "conservadora a princípio (sem necessidade de cirurgia)". Adapte conforme o caso informado — ex: se o médico disser que o tratamento será cirúrgico, use "cirúrgica"
- [DD/MM/AAAA] ([dia da semana]): data numérica completa. SEMPRE confira e escreva o dia da semana correspondente à data (ex: "15/03/2026 (domingo)"). Use a data de hoje informada no contexto como referência para interpretar expressões como "amanhã", "semana que vem", "próxima segunda"
- [horário]: no formato "14h" ou "14h30"
- [HOSPITAL]: só pode ser um destes dois: "HSM Santiago" ou "HSM SBC". VALOR PADRÃO se o médico não especificar: HSM Santiago. Só use HSM SBC se o médico mencionar explicitamente
- Se faltar nome, conduta, data ou horário, deixe o campo do template sem preencher (mantendo a frase ao redor coerente) e sinalize a ausência na linha de aviso do topo — nunca invente o valor nem escreva "NÃO INFORMADO"
- Se houver múltiplos pacientes, gere uma mensagem separada para cada um, separadas por uma linha em branco e uma linha com "———"`
  }
};

function montarPromptMensagem({ dadosCaso, template, dataHoje }) {
  const modelo = MENSAGENS[template];
  if (!modelo) return 'Modelo de mensagem não encontrado.';

  let partes = [];

  if (dataHoje) {
    partes.push(`DATA DE HOJE (para calcular dias da semana e interpretar expressões como "amanhã" ou "próxima segunda"): ${dataHoje}`);
  }

  partes.push(`\nMODELO A USAR: ${modelo.nome}\n\n${modelo.texto}`);
  partes.push(`\nDADOS ENVIADOS PELO MÉDICO:\n${dadosCaso}`);
  partes.push(`\nGere a mensagem agora, seguindo exatamente o modelo acima.`);

  return partes.join('\n');
}

/* ===================== GERADOR AVULSO (Exames / Fisioterapia / Atestados) ===================== */
// Usado na aba "Textos prontos", quando o caso foge dos itens já cadastrados.
// Gera um item novo no mesmo formato dos exemplos já existentes daquela categoria,
// sem salvar nada — é só para aquele uso pontual.

function montarPromptSistemaAvulso() {
  return `Você é um assistente do Dr. Matheus, ortopedista do Hospital Sancta Maggiore (HSM) Madrid.
Sua função é gerar UM único item de texto pronto (pedido de exame, encaminhamento de fisioterapia, ou atestado), no MESMO formato e estilo dos exemplos fornecidos daquela categoria.

REGRAS GERAIS:
- Copie exatamente o padrão de estrutura, pontuação e organização dos exemplos (ex: "SOLICITO:" seguido de linhas, ou o texto corrido de um atestado)
- Se a categoria envolver CID-10 e o médico não informou o código, você deve determinar o CID-10 correto com base no diagnóstico informado — essa é justamente a parte que o médico não sabe de cabeça e está pedindo para você resolver
- Se não tiver certeza absoluta do CID-10 mais adequado, escolha o mais clinicamente apropriado e comum para aquele diagnóstico; nunca deixe o campo de CID em branco ou com placeholder
- Não invente detalhes que não foram pedidos (lado, quantidade de sessões, etc.) além do que os exemplos já trazem como padrão — mantenha esses valores padrão dos exemplos quando não especificado
- Devolva APENAS o texto final do item, pronto para copiar e colar. Sem comentários antes ou depois, sem aspas, sem markdown`;
}

function montarPromptAvulso({ categoria, exemplos, pedido, tipoAtestado, diasAfastamento, diagnosticoAtestado }) {
  let partes = [];

  partes.push(`CATEGORIA: ${categoria}`);

  if (Array.isArray(exemplos) && exemplos.length) {
    partes.push(`\nEXEMPLOS JÁ CADASTRADOS NESTA CATEGORIA (siga exatamente este formato/estilo):\n`);
    exemplos.forEach(function(ex) {
      partes.push(`--- ${ex.titulo} ---\n${ex.texto}\n`);
    });
  }

  if (categoria === 'Atestados') {
    partes.push(`\nUse como base o exemplo de "${tipoAtestado === 'pediatria' ? 'Atestado Pediatria' : 'Atestado de Trabalho'}" acima.`);
    partes.push(`Dias de afastamento/dispensa: ${diasAfastamento || 'não informado — mantenha o formato do exemplo (linha em branco para preencher à mão) se não for possível determinar'}`);
    partes.push(`Diagnóstico informado pelo médico: ${diagnosticoAtestado}`);
    partes.push(`\nGere o atestado completo, preenchendo os dias e determinando o CID-10 correto a partir do diagnóstico informado (apenas se o exemplo de referência tiver campo de CID-10).`);
  } else {
    partes.push(`\nPEDIDO DO MÉDICO (o que ele precisa, do jeito que escreveu):\n${pedido}`);
    partes.push(`\nGere o item completo agora, no mesmo formato dos exemplos acima, adaptado ao pedido.`);
  }

  return partes.join('\n');
}

/* ===================== IMAGENS ===================== */

// Monta o array de "parts" para a API do Gemini, incluindo imagens quando houver.
// Limita a quantidade e o tamanho para não estourar a requisição.
const MAX_IMAGENS = 6;

function montarParts(promptUsuario, imagens) {
  const parts = [];

  if (Array.isArray(imagens) && imagens.length) {
    imagens.slice(0, MAX_IMAGENS).forEach(img => {
      if (img && img.base64 && img.mimeType) {
        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: img.base64
          }
        });
      }
    });

    parts.push({
      text: 'As imagens acima foram anexadas pelo médico. Leia o conteúdo delas (laudos, resultados de exame, prints de sistema, radiografias) e use as informações relevantes junto com os dados em texto abaixo. Se a imagem estiver ilegível ou não contiver informação útil, sinalize isso em uma linha de aviso no topo. Nunca invente conteúdo que não esteja visível na imagem.'
    });
  }

  parts.push({ text: promptUsuario });

  return parts;
}
