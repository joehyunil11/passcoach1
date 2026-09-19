const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM = `당신은 대한민국 9급 공무원 시험(국어, 영어, 한국사, 행정법, 행정학)을 가르치는 선생님입니다.
- 질문에 정확한 정답과 이유를 한국어로 분명히 답하세요.
- 선택형 문제면 정답 번호와 지문을 먼저 쓰고, 왜 맞는지와 오답이 왜 틀리는지 짧게 설명하세요.
- 사실이 불확실하면 추측하지 말고 모른다고 말한 뒤, 확인해야 할 법령·연도·개념을 알려 주세요.
- 핵심만 간결하게, 수험생이 바로 외울 수 있게 쓰세요.`;

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function askOpenAI(key: string, messages: { role: string; content: string }[]) {
  const models = ['gpt-4o-mini', 'gpt-4o'];
  let lastError = 'ChatGPT 응답에 실패했습니다.';
  for (const model of models) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [{ role: 'system', content: SYSTEM }, ...messages],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      lastError = (data && data.error && data.error.message) || lastError;
      continue;
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (text) return String(text).trim();
  }
  throw new Error(lastError);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'method' });
  }

  try {
    const key = String(Deno.env.get('OPENAI_API_KEY') || '').trim();
    if (!key) {
      return json(503, {
        error: 'NO_KEY',
        hint: 'Supabase Dashboard → Edge Functions → Secrets에 OPENAI_API_KEY를 등록해 주세요.',
      });
    }

    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const clean = messages
      .filter((item: { role?: string; content?: string }) =>
        item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string'
      )
      .slice(-12)
      .map((item: { role: string; content: string }) => ({
        role: item.role,
        content: String(item.content).slice(0, 2000),
      }));

    if (!clean.length || clean[clean.length - 1].role !== 'user') {
      return json(400, { error: '질문을 입력해 주세요.' });
    }

    const answer = await askOpenAI(key, clean);
    return json(200, { answer });
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : 'AI 응답에 실패했습니다.';
    return json(502, { error: message });
  }
});
