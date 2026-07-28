import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getShareLinkLabel, getShareScope } from "../auth/authService.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const getOrigin = (req: http.IncomingMessage): string => {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    "http";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
};

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|mkv|webm|avi|wmv)$/i;

export const sharePreviewHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  const url = new URL(req.url!, "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  const shareScope = getShareScope(token);
  if (!shareScope) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("This share link is invalid or has been revoked.");
    return;
  }

  // Use description embedded in the token (new links) or look it up from DB.
  const description =
    shareScope.description ??
    (await getShareLinkLabel(token)) ??
    shareScope.semanticQuery ??
    "Shared photos";

  // Fetch up to 4 preview images using the base filter (no ML resolution needed for bots).
  const baseFilter = (shareScope.filter ?? {}) as FilterElement;
  let previewPaths: string[] = [];
  let totalCount = 0;
  try {
    const result = await database.queryFiles({
      filter: baseFilter,
      metadata: ["mimeType"],
      pageSize: 8,
    });
    totalCount = result.total;
    // Prefer images over videos for the preview mosaic.
    const items = result.items
      .filter(
        (f) =>
          !f.mimeType?.startsWith("video/") && !VIDEO_EXTENSIONS.test(f.fileName),
      )
      .slice(0, 4);
    previewPaths = items.map((f) => {
      // folder starts and ends with /, so folder + fileName = /path/to/file.jpg
      const rel = (f.folder + f.fileName).slice(1); // strip leading /
      return rel.split("/").map(encodeURIComponent).join("/");
    });
  } catch {
    // Best-effort — proceed without images.
  }

  const origin = process.env.PHOTRIX_PUBLIC_URL?.replace(/\/$/, "") ?? getOrigin(req);
  const appUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  const countLabel =
    totalCount > 0
      ? `${totalCount.toLocaleString("en-US")} ${totalCount === 1 ? "item" : "items"}`
      : "Shared";
  const ogDescription = `${countLabel} · Shared via Photrix`;

  // Serve OG preview images as JPEG: link-unfurl bots (Microsoft Teams, Outlook)
  // can't decode the default WebP and silently drop the entire preview card.
  const imageUrls = previewPaths.map(
    (p) =>
      `${origin}/api/files/${p}?representation=webSafe&height=630&format=jpeg&token=${encodeURIComponent(token)}`,
  );

  const ogImageTags = imageUrls
    .map(
      (u) =>
        `  <meta property="og:image" content="${escapeHtml(u)}" />\n` +
        `  <meta property="og:image:type" content="image/jpeg" />`,
    )
    .join("\n");

  const twitterImageTag = imageUrls[0]
    ? `  <meta name="twitter:image" content="${escapeHtml(imageUrls[0])}" />`
    : "";

  // Mosaic grid for the preview page (up to 4 images in a 2×2 grid).
  const mosaicHtml =
    imageUrls.length > 0
      ? `<div class="mosaic" data-count="${imageUrls.length}">
      ${imageUrls.map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy" />`).join("\n      ")}
    </div>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(description)} – Photrix</title>

  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(appUrl)}" />
  <meta property="og:title" content="${escapeHtml(description)}" />
  <meta property="og:description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:site_name" content="Photrix" />
${ogImageTags}

  <meta name="twitter:card" content="${imageUrls.length > 0 ? "summary_large_image" : "summary"}" />
  <meta name="twitter:title" content="${escapeHtml(description)}" />
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}" />
${twitterImageTag}

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f0f0f;
      color: #e5e5e5;
      min-height: 100svh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 16px;
      overflow: hidden;
    }
    .mosaic {
      display: grid;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #111;
    }
    .mosaic[data-count="1"] { grid-template-columns: 1fr; }
    .mosaic[data-count="2"] { grid-template-columns: 1fr 1fr; }
    .mosaic[data-count="3"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .mosaic[data-count="3"] img:first-child { grid-column: 1; grid-row: 1 / 3; }
    .mosaic[data-count="4"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
    .mosaic img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .body { padding: 1.25rem 1.25rem 1.5rem; }
    .logo { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: #666; margin-bottom: .5rem; }
    h1 { font-size: 1.1rem; font-weight: 600; line-height: 1.3; margin-bottom: .3rem; }
    .meta { font-size: .85rem; color: #888; margin-bottom: 1.25rem; }
    a.open {
      display: block;
      text-align: center;
      padding: .65rem 1rem;
      background: #3b82f6;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: .9rem;
      font-weight: 500;
    }
    a.open:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    ${mosaicHtml}
    <div class="body">
      <div class="logo">Photrix</div>
      <h1>${escapeHtml(description)}</h1>
      <p class="meta">${escapeHtml(ogDescription)}</p>
      <a class="open" href="${escapeHtml(appUrl)}">Open shared view</a>
    </div>
  </div>
  <script>window.location.replace(${JSON.stringify(appUrl)});</script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};
