// Catálogo padrão — baseado na pesquisa de 30/09/2026, revisado em 01/10/2026 (Groq, Gemini, OpenRouter, Hugging Face) (fontes oficiais no Guia).
// v: visão · t: tool calling · a: áudio
window.CATALOG_DATE = '01/10/2026';

window.DEFAULT_PROVIDERS = [
  {
    id: 'groq', name: 'Groq', tier: 'free',
    baseURL: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    rpm: 30, rpd: 1000,
    limits: '30 RPM · 1K RPD · 8K TPM · 200K TPD (por modelo)',
    training: 'Não treina (Services Agreement §4.2)',
    notes: 'Não aceita logprobs, logit_bias, top_logprobs, messages[].name; n precisa ser 1. Llama 3.x (agora só Enterprise) e Qwen 3.6 foram desligados no grátis/Developer.',
    models: [
      { id: 'openai/gpt-oss-120b', t: 1 },
      { id: 'qwen/qwen3.8-27b', v: 1, t: 1 },
      { id: 'openai/gpt-oss-20b', t: 1 }
    ]
  },
  {
    id: 'cerebras', name: 'Cerebras', tier: 'free',
    baseURL: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    rpm: 5, rpd: null,
    limits: 'Trial: 5 RPM · 1M TPD · US$5 por 30 dias (exige meio de pagamento)',
    training: 'Não retém prompts/respostas',
    notes: 'Imagens só em base64 PNG/JPEG. Não combinar tools + response_format.',
    models: [
      { id: 'gpt-oss-120b', t: 1 },
      { id: 'qwen-3.8-27b', v: 1, t: 1 }
    ]
  },
  {
    id: 'gemini', name: 'Google Gemini', tier: 'free',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    rpm: null, rpd: 20,
    limits: 'Não publicado por modelo (ver AI Studio). Relatos: ~20 RPD no 3.8 Flash, mais no Flash-Lite',
    training: 'SIM — plano grátis usado para melhorar produtos, com revisão humana',
    notes: 'Limite por projeto, não por chave. RPD zera à meia-noite do Pacífico. Modelos 2.5 só liberados para quem já os usava (projetos novos: 3.5 Flash-Lite ou 3.8 Flash).',
    models: [
      { id: 'gemini-3.8-flash', v: 1, t: 1, a: 1 },
      { id: 'gemini-3.5-flash-lite', v: 1, t: 1, a: 1 },
      { id: 'gemini-3.1-flash-lite', v: 1, t: 1, a: 1 },
      { id: 'gemini-2.5-flash', v: 1, t: 1, a: 1 },
      { id: 'gemini-2.5-pro', v: 1, t: 1, a: 1 }
    ]
  },
  {
    id: 'openrouter', name: 'OpenRouter (:free)', tier: 'free',
    baseURL: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    rpm: 20, rpd: 50,
    limits: '20 RPM · 50 RPD (1000 RPD após comprar 10 créditos)',
    training: 'OpenRouter não treina; provedores de modelos grátis podem treinar',
    notes: 'Termos §7.3 proíbem várias contas para contornar limites. Lista :free muda toda semana — use "Buscar modelos".',
    models: [
      { id: 'qwen/qwen3.8-27b:free', v: 1, t: 1 },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', t: 1 }
    ]
  },
  {
    id: 'sambanova', cors: false, name: 'SambaNova', tier: 'free',
    baseURL: 'https://api.sambanova.ai/v1',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    rpm: 20, rpd: 20,
    limits: 'Free Tier: 20 RPM · 20 RPD · 200K TPD',
    training: 'Não informado',
    notes: 'Free Tier = conta sem meio de pagamento.',
    models: [
      { id: 'DeepSeek-V3.1', t: 1 },
      { id: 'gpt-oss-120b', t: 1 },
      { id: 'Meta-Llama-3.3-70B-Instruct', t: 1 },
      { id: 'DeepSeek-V3.2', t: 1 },
      { id: 'gemma-4-31B-it' }
    ]
  },
  {
    id: 'nvidia', cors: false, name: 'NVIDIA NIM', tier: 'free',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/settings',
    rpm: 40, rpd: null,
    limits: '~40 RPM · 1.000 créditos de trial (sem cartão)',
    training: 'Uso apenas para prestar o serviço (Trial ToS, via fórum)',
    notes: 'Trial para prototipação, não produção.',
    models: [
      { id: 'openai/gpt-oss-120b', t: 1 },
      { id: 'nvidia/nemotron-3-super-120b-a12b', t: 1 },
      { id: 'mistralai/mistral-small-4-119b-2603', t: 1 }
    ]
  },
  {
    id: 'mistral-free', name: 'Mistral (Experiment)', tier: 'free',
    baseURL: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    rpm: null, rpd: null,
    limits: 'Não publicado (ver console). Exige telefone verificado',
    training: 'SIM por padrão — desative em Admin → Privacy',
    notes: 'IDs inferidos; confirme com "Buscar modelos".',
    models: [
      { id: 'mistral-small-2603', v: 1, t: 1 },
      { id: 'mistral-medium-2604', v: 1, t: 1 }
    ]
  },
  {
    id: 'cloudflare', cors: false, name: 'Cloudflare Workers AI', tier: 'free',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    needsAccount: true,
    rpm: 300, rpd: null,
    limits: '10.000 Neurons/dia grátis · Text Gen 300 RPM',
    training: 'Não treina com conteúdo do cliente',
    notes: 'Informe o Account ID. Alguns modelos exigem plano Workers Paid.',
    models: [
      { id: '@cf/openai/gpt-oss-120b', t: 1 },
      { id: '@cf/qwen/qwen3.8-27b', v: 1, t: 1 },
      { id: '@cf/moonshotai/kimi-k2.7-code', v: 1, t: 1 },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', v: 1, t: 1 }
    ]
  },
  {
    id: 'huggingface', name: 'Hugging Face', tier: 'free',
    baseURL: 'https://router.huggingface.co/v1',
    keyUrl: 'https://huggingface.co/settings/tokens',
    rpm: null, rpd: null,
    limits: 'US$ 0,10/mês em créditos na conta grátis (US$ 2 no PRO); limites por minuto não publicados',
    training: 'HF não treina nem guarda prompts/respostas (logs de até 30 dias, sem conteúdo); o provedor parceiro escolhido pelo roteador tem política própria',
    notes: 'Token com permissão "Make calls to Inference Providers". Sufixos no ID: :fastest (padrão), :cheapest, :preferred ou :nome-do-provedor (ex.: openai/gpt-oss-120b:groq). Use "Buscar modelos" — são 130+.',
    models: [
      { id: 'openai/gpt-oss-120b', t: 1 },
      { id: 'Qwen/Qwen3.8-27B', v: 1, t: 1 },
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', v: 1, t: 1 },
      { id: 'google/gemma-4-31B-it', v: 1, t: 1 },
      { id: 'moonshotai/Kimi-K3', v: 1, t: 1 },
      { id: 'zai-org/GLM-5.3', t: 1 }
    ]
  },
  {
    id: 'pollinations', name: 'Pollinations', tier: 'free',
    baseURL: 'https://gen.pollinations.ai/v1',
    keyUrl: 'https://enter.pollinations.ai/keys',
    rpm: null, rpd: null,
    limits: 'Créditos “Pollen” grátis via missões (ex.: 3 Pollen por conta GitHub com 2+ anos). Chave pk_: 1 Pollen/hora por IP',
    training: 'Não informado',
    notes: 'A mesma chave libera imagem e voz na aba Criar. Sem chave, só algumas imagens por IP antes de pedir chave. Modelos marcados “paid_only” exigem saldo pago.',
    models: [
      { id: 'openai/gpt-5.4-nano', v: 1, t: 1 },
      { id: 'z-ai/glm-5.3-flash', v: 1, t: 1 },
      { id: 'nvidia/nemotron-3.5-lightning', t: 1 },
      { id: 'deepseek/deepseek-v4.1-flash', t: 1 }
    ]
  },
  {
    id: 'ollama', name: 'Ollama (local / rede)', tier: 'local', noKey: true,
    baseURL: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com/library',
    rpm: null, rpd: null,
    limits: 'Sem limite — depende do seu hardware',
    training: 'Dados ficam na sua máquina',
    notes: 'No navegador: rode com OLLAMA_ORIGINS="*". Pelo site em HTTPS, só http://localhost funciona (IP da rede é bloqueado como conteúdo misto) — para usar na rede, exponha o Ollama via HTTPS (ex.: túnel) ou use o proxy.',
    models: [
      { id: 'qwen3.8:27b', v: 1, t: 1 },
      { id: 'gemma4:e4b', v: 1, t: 1, a: 1 },
      { id: 'gemma4:12b', v: 1, t: 1 },
      { id: 'gpt-oss:20b', t: 1 },
      { id: 'lfm2.5:8b', t: 1 }
    ]
  },
  {
    id: 'deepseek', name: 'DeepSeek', tier: 'paid',
    baseURL: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    limits: 'flash: $0,30 / $1,20 · v4-pro: $1,32 / $3,96 (por 1M; metade fora do pico)',
    training: 'Ver política do provedor',
    notes: 'Também aceita formato Anthropic em /anthropic.',
    models: [
      { id: 'deepseek-flash', v: 1, t: 1, price: [0.3, 1.2] },
      { id: 'deepseek-v4-pro', t: 1, price: [1.32, 3.96] }
    ]
  },
  {
    id: 'mistral', name: 'Mistral', tier: 'paid',
    baseURL: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    limits: 'Small 4 $0,15/$0,60 · Large 3 $0,50/$1,50 · Medium 3.5 $1,50/$7,50',
    training: 'Ver política (opt-out disponível)',
    notes: 'IDs inferidos do padrão da documentação.',
    models: [
      { id: 'mistral-small-2603', v: 1, t: 1, price: [0.15, 0.6] },
      { id: 'mistral-large-2512', v: 1, t: 1, price: [0.5, 1.5] },
      { id: 'mistral-medium-2604', v: 1, t: 1, price: [1.5, 7.5] }
    ]
  },
  {
    id: 'google', name: 'Google (pago)', tier: 'paid',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    limits: '3.8 Flash $0,75/$3,75 (até 31/12/2026) · 3.1 Pro Preview $2/$12',
    training: 'Plano pago: não usado para melhorar produtos',
    notes: 'Mesma chave do AI Studio, em projeto com faturamento ativo.',
    models: [
      { id: 'gemini-3.8-flash', v: 1, t: 1, a: 1, price: [0.75, 3.75] },
      { id: 'gemini-3.1-pro-preview', v: 1, t: 1, a: 1, price: [2, 12] },
      { id: 'gemini-3.5-flash-lite', v: 1, t: 1, price: [0.3, 2.5] }
    ]
  },
  {
    id: 'openai', name: 'OpenAI', tier: 'paid',
    baseURL: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    limits: 'Luna $0,10/$0,50 · Sol $2/$10 · Astra $10/$50 (1M tokens)',
    training: 'API: não treina por padrão',
    notes: 'Contexto 1,05M; preço maior acima de 272K.',
    models: [
      { id: 'gpt-6-luna', v: 1, t: 1, price: [0.1, 0.5] },
      { id: 'gpt-6.1-sol', v: 1, t: 1, price: [2, 10] },
      { id: 'gpt-6-astra', v: 1, t: 1, price: [10, 50] }
    ]
  },
  {
    id: 'xai', name: 'xAI', tier: 'paid',
    baseURL: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    limits: 'grok-4.7 $2/$6 · 500K contexto',
    training: 'Ver política do provedor',
    notes: 'Endpoint US: https://us.api.x.ai/v1 (1,1x).',
    models: [
      { id: 'grok-4.7', v: 1, t: 1, price: [2, 6] },
      { id: 'grok-4.3', v: 1, t: 1, price: [1.25, null] }
    ]
  },
  {
    id: 'anthropic', name: 'Anthropic', tier: 'paid',
    baseURL: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    limits: 'Haiku 4.5 $1/$5 · Sonnet 5.5 $2/$10 · Opus 5.5 $4/$20 · Fable 5.1 $10/$50',
    training: 'API: não treina por padrão',
    notes: 'Usa a camada compatível com OpenAI (ignora strict, response_format, cache).',
    models: [
      { id: 'claude-haiku-4-5-20251001', v: 1, t: 1, price: [1, 5] },
      { id: 'claude-sonnet-5-5', v: 1, t: 1, price: [2, 10] },
      { id: 'claude-opus-5-5', v: 1, t: 1, price: [4, 20] }
    ]
  },
  {
    id: 'ollama-cloud', cors: false, name: 'Ollama Cloud', tier: 'paid',
    baseURL: 'https://ollama.com/v1',
    keyUrl: 'https://ollama.com/settings/keys',
    limits: 'Limites e preço não verificados',
    training: 'Ver política do provedor',
    notes: 'IDs vêm de ollama.com/api/tags.',
    models: [
      { id: 'gemma4:31b', v: 1, t: 1 },
      { id: 'gpt-oss:120b', t: 1 }
    ]
  }
];

// Conteúdo do Guia (resumo da pesquisa).
window.GUIDE = {
  alerts: [
    ['⚠️ GitHub Models aposentado', 'Desde 30/07/2026 a API de inferência não existe mais.', 'https://github.blog/changelog/2026-07-30-github-models-is-now-retired/'],
    ['⚠️ Groq trocou modelos', 'Llama 3.1/3.3 desligados em 16/08; Qwen 3.6 → Qwen 3.8 em 14/09/2026.', 'https://console.groq.com/docs/deprecations'],
    ['⚠️ MCP 2026-07-28', 'Protocolo stateless: sem initialize e sem Mcp-Session-Id. SDK TS v2 (@modelcontextprotocol/server 2.2.0).', 'https://modelcontextprotocol.io/specification/latest/changelog'],
    ['Várias contas', 'OpenRouter §7.3 proíbe várias contas para contornar limites; Mistral: 1 telefone por plano. Rotacione provedores, não contas.', 'https://openrouter.ai/terms'],
    ['Treino com seus dados', 'Gemini grátis e Mistral Experiment usam seus dados por padrão. Não envie dados sensíveis para eles.', 'https://ai.google.dev/gemini-api/terms']
  ],
  sources: [
    ['Groq rate limits', 'https://console.groq.com/docs/rate-limits'],
    ['Gemini OpenAI compat', 'https://ai.google.dev/gemini-api/docs/openai'],
    ['Gemini pricing', 'https://ai.google.dev/gemini-api/docs/pricing'],
    ['OpenRouter limits', 'https://openrouter.ai/docs/api/reference/limits'],
    ['Cerebras rate limits', 'https://inference-docs.cerebras.ai/support/rate-limits'],
    ['SambaNova rate limits', 'https://docs.sambanova.ai/docs/en/models/rate-limits'],
    ['NVIDIA NIM', 'https://build.nvidia.com/llms.txt'],
    ['Pollinations API (OpenAPI)', 'https://gen.pollinations.ai/openapi.json'],
    ['Cloudflare Workers AI — FLUX schnell', 'https://developers.cloudflare.com/workers-ai/platform/pricing/'],
    ['Groq Speech-to-Text', 'https://console.groq.com/docs/speech-to-text'],
    ['Hugging Face Inference Providers', 'https://huggingface.co/docs/inference-providers/pricing'],
    ['Cloudflare Workers AI pricing', 'https://developers.cloudflare.com/workers-ai/platform/pricing/'],
    ['Mistral pricing', 'https://docs.mistral.ai/inference/pricing'],
    ['OpenAI pricing', 'https://platform.openai.com/docs/pricing'],
    ['Claude models', 'https://platform.claude.com/docs/en/models/overview'],
    ['Claude OpenAI SDK', 'https://docs.claude.com/en/api/openai-sdk'],
    ['DeepSeek pricing', 'https://api-docs.deepseek.com/quick_start/pricing'],
    ['xAI pricing', 'https://docs.x.ai/developers/pricing'],
    ['Ollama OpenAI compat', 'https://docs.ollama.com/api/openai-compatibility'],
    ['MCP versioning', 'https://modelcontextprotocol.io/specification/versioning'],
    ['MCP security', 'https://modelcontextprotocol.io/specification/latest/basic/security_best_practices']
  ],
  local: [
    ['qwen3.8:27b', '18 GB · visão + tools · 256K', '~24 GB VRAM / 32 GB RAM'],
    ['gemma4:e4b', '6,6–9,5 GB · visão + áudio + tools', '8–12 GB'],
    ['gemma4:12b', '7,7–8 GB · visão + tools · 256K', '~12 GB'],
    ['gemma4:26b / 31b', '16–20 GB · visão + tools', '~24 GB'],
    ['qwen3.5:9b', '6,6 GB · visão + tools', '8–10 GB'],
    ['gpt-oss:20b', '14 GB · tools, sem visão', '16 GB (oficial)'],
    ['nemotron-3.5-lightning', '25 GB · tools · 1M ctx', '~32 GB'],
    ['lfm2.5:8b', '5,2 GB · tools', '~8 GB']
  ],
  mcp: [
    ['Especificação', '2026-07-28 (stateless, server/discover obrigatório)'],
    ['SDK TypeScript', 'v2: @modelcontextprotocol/server e /client 2.2.0 · v1 legado: @modelcontextprotocol/sdk 1.31.0'],
    ['Transportes', 'stdio e Streamable HTTP. HTTP+SSE depreciado desde 2025-03-26'],
    ['Segurança', 'Sem token passthrough · validar audiência e iss · bloquear SSRF (IPs privados, 169.254.169.254) · mostrar comando completo antes de rodar servidor local · sandbox'],
    ['Servidores', 'Filesystem, Fetch, Git, Memory, Sequential Thinking, Time, GitHub, Playwright, Context7, Notion, Sentry, Supabase']
  ],
  media: [
    ['Imagem', 'Pollinations (z-image, FLUX schnell) — algumas sem chave, depois com chave grátis · Cloudflare FLUX.1 schnell — ~85 imagens/dia nos 10.000 Neurons grátis (via proxy)'],
    ['Vídeo', 'Nenhuma API de vídeo por IA é grátis hoje (Pollinations marca todos como paid_only). O app monta vídeo grátis: cenas pela IA grátis + imagens grátis + animação gravada no navegador'],
    ['Voz (falar)', 'Voz do navegador (grátis, offline) · Pollinations tts-1 com chave grátis'],
    ['Voz (ouvir/ditar)', 'Ditado do navegador (grátis) · Groq Whisper (grátis com chave Groq)']
  ],
  cors: [
    ['Funciona direto do navegador', 'Groq, Cerebras, Gemini, OpenRouter, Hugging Face, Pollinations, Mistral, DeepSeek, OpenAI, xAI, Anthropic (com cabeçalho de acesso direto)'],
    ['Precisa de proxy', 'SambaNova, NVIDIA NIM, Cloudflare Workers AI, Ollama Cloud — não enviam Access-Control-Allow-Origin'],
    ['Ollama local', 'OLLAMA_ORIGINS="*" e endereço localhost (ou HTTPS)']
  ],
  stale: [
    'Lista :free do OpenRouter (muda semanalmente)',
    'Limites do Gemini grátis (só no AI Studio)',
    'Tabela free × Developer do Groq',
    'Preços promocionais: Gemini 3.x Flash até 31/12/2026, GPT-5.6 Sol até 21/11/2026',
    'IDs mistral-medium-2604 / mistral-large-2512 (inferidos)',
    'Requisitos de RAM do Ollama (estimativas)',
    'Política de CORS dos provedores (testada em 30/09/2026)',
    'Cota sem chave da Pollinations (não publicada; muda sem aviso)'
  ]
};
