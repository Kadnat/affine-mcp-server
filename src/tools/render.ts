import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";

// Screenshots a doc's edgeless canvas in headless Chrome so the agent can see
// what it built (overlaps, cut-off text, wrong colors) and fix it.
// ponytail: one browser launch per call (~3-5s); keep a warm browser if this gets called in loops.
export function registerRenderTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const renderCanvasHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    fit?: boolean;
    width?: number;
    height?: number;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const width = parsed.width ?? 1600;
    const height = parsed.height ?? 1000;

    let chromium: any;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error("render_canvas needs the 'playwright' package (npm i playwright) and a local Chrome.");
    }

    const { cookie, bearer } = await gql.getConnectionAuth();
    const base = new URL(gql.baseUrl);
    const url = `${base.origin}/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(parsed.docId)}?mode=edgeless`;

    // Prefer the installed Chrome (no browser download); fall back to Playwright's bundled one.
    const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
    try {
      const context = await browser.newContext({
        viewport: { width: width + 260, height },
        deviceScaleFactor: 1,
        ...(bearer ? { extraHTTPHeaders: { Authorization: `Bearer ${bearer}` } } : {}),
      });
      if (cookie) {
        await context.addCookies(
          cookie.split(";").map(part => part.trim()).filter(part => part.includes("=")).map(part => ({
            name: part.slice(0, part.indexOf("=")),
            value: part.slice(part.indexOf("=") + 1),
            domain: base.hostname,
            path: "/",
            secure: base.protocol === "https:",
          })),
        );
      }
      const page = await context.newPage();
      await page.goto(url);
      const root = page.locator("affine-edgeless-root");
      await root.waitFor({ timeout: 30_000 });
      // Let blobs, fonts and the note layout settle before measuring.
      await page.waitForTimeout(2_500);
      await page.evaluate((fit: boolean) => {
        const edgeless = document.querySelector("affine-edgeless-root") as any;
        if (fit) edgeless?.gfx?.fitToScreen?.();
        const style = document.createElement("style");
        style.textContent = "edgeless-toolbar-widget, affine-edgeless-zoom-toolbar-widget { display: none !important; }";
        document.head.appendChild(style);
        // Drop floating UI (app banner, toasts) that would sit over the canvas in the capture.
        for (const el of document.querySelectorAll("body *")) {
          if (getComputedStyle(el).position === "fixed" && !el.contains(edgeless) && !edgeless?.contains(el)) el.remove();
        }
      }, parsed.fit !== false);
      await page.waitForTimeout(800);
      const png: Buffer = await root.screenshot();
      return {
        content: [
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          { type: "text" as const, text: `Rendered ${url}` },
        ],
        structuredContent: { docId: parsed.docId, url, bytes: png.length },
      };
    } finally {
      await browser.close();
    }
  };

  server.registerTool(
    "render_canvas",
    {
      title: "Render Canvas",
      description:
        "Screenshot a document's edgeless canvas (zoomed to fit) and return it as a PNG image. Use it after building or editing a board to check the result visually: overlaps, clipped text, alignment, colors. Requires a local Chrome and stdio transport.",
      inputSchema: {
        workspaceId: z.string().optional().describe("AFFiNE workspace id. Omit only when AFFINE_WORKSPACE_ID is configured."),
        docId: z.string().min(1).describe("Document id to render."),
        fit: z.boolean().optional().describe("Zoom to fit all content before capturing (default true)."),
        width: z.number().int().min(400).max(3840).optional().describe("Canvas viewport width in px (default 1600)."),
        height: z.number().int().min(300).max(2160).optional().describe("Canvas viewport height in px (default 1000)."),
      },
    },
    renderCanvasHandler as any,
  );
}
