import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "path";

// 构建产物输出到 dist/，由 Flask 托管（app.py 中新增 dist 路由）。
// 资源带内容哈希，天然解决浏览器缓存问题，无需手动维护版本号。
export default defineConfig({
  plugins: [solid()],
  root: resolve(__dirname, "src"),
  base: "/",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, "src", "index.html"),
    },
  },
  server: {
    proxy: {
      // 开发期把 API 请求代理到 Flask 后端（默认 5000），
      // 这样 `pnpm dev` 单独跑前端时也能联调。
      "/api": "http://127.0.0.1:5000",
      "/uploads": "http://127.0.0.1:5000",
    },
  },
});
