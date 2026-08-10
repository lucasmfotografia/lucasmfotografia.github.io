// ============================================================
// WORKER: intermediário seguro entre o site e o R2
// ============================================================
// Cole este código no Cloudflare Workers (Dashboard > Workers > criar).
// Ele nunca expõe nenhuma chave — o acesso ao R2 é feito por um
// "binding" configurado no próprio painel do Worker (passo a passo
// que vou te dar em seguida), e a verificação de admin é feita
// consultando o Supabase com o login de quem está enviando.
// ============================================================

const SUPABASE_URL = "https://xyrpahplszsogmjljjcj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_47DuOJhFf0BXx4VbRoPrEw_esik8smx";

// Base pública das fotos depois de criar o bucket (ex: https://pub-xxxx.r2.dev)
// Preencha depois de seguir o passo "Ativar acesso público" do guia.
const PUBLIC_BASE_URL = "https://pub-cf6d43bd33a04123bbeec593632460c8.r2.dev";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-gallery-id, x-file-name",
  };
}

async function isAdmin(token) {
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();

  const adminRes = await fetch(`${SUPABASE_URL}/rest/v1/admins?id=eq.${user.id}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  const rows = await adminRes.json();
  return Array.isArray(rows) && rows.length > 0 ? user.id : null;
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders();
    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);

    // GET /list?gallery=<id>  — pública, lista as fotos de uma galeria
    if (request.method === "GET" && url.pathname === "/list") {
      const galleryId = url.searchParams.get("gallery");
      if (!galleryId) {
        return new Response(JSON.stringify({ error: "Faltou o parâmetro gallery" }), { status: 400, headers });
      }
      const listed = await env.PHOTOS_BUCKET.list({ prefix: `${galleryId}/` });
      const photos = listed.objects.map((obj) => ({
        name: obj.key.split("/").pop(),
        url: `${PUBLIC_BASE_URL}/${obj.key}`,
      }));
      return new Response(JSON.stringify({ photos }), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // POST /upload  — só para admin autenticado
    if (request.method === "POST" && url.pathname === "/upload") {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace("Bearer ", "");
      if (!token) {
        return new Response(JSON.stringify({ error: "Sem login" }), { status: 401, headers });
      }

      const adminId = await isAdmin(token);
      if (!adminId) {
        return new Response(JSON.stringify({ error: "Sem permissão de admin" }), { status: 403, headers });
      }

      const galleryId = request.headers.get("x-gallery-id");
      const fileName = request.headers.get("x-file-name");
      if (!galleryId || !fileName) {
        return new Response(JSON.stringify({ error: "Faltou gallery id ou nome do arquivo" }), { status: 400, headers });
      }

      const key = `${galleryId}/${Date.now()}-${fileName}`;
      await env.PHOTOS_BUCKET.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
      });

      return new Response(JSON.stringify({ key, url: `${PUBLIC_BASE_URL}/${key}` }), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Rota não encontrada" }), { status: 404, headers });
  },
};
