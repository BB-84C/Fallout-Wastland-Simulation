import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "dist");

/**
 * 1️⃣ 对 index.html 禁止缓存（核心）
 */
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

/**
 * 2️⃣ 静态资源
 * - index.html：no-store（上面已处理）
 * - assets：强缓存
 */
app.use(
  express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.includes("/assets/")) {
        res.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );
      }
    },
  })
);

/**
 * 3️⃣ SPA fallback
 * 必须再次确保 index.html 不缓存
 */
app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on ${PORT}`);
});
