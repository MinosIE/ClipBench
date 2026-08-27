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
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, "src", "index.html"),
    },
  },
  server: {
    proxy: {
      // 开发期把 API/静态文件请求代理到 Flask 后端（默认 8080）。
      // 注意：macOS 的「隔空播放接收器」会占用 5000 端口（返回 403），
      // 因此这里必须指向 8080，否则 `pnpm dev` 联调时全部请求 403。
      "/api": "http://127.0.0.1:8080",
      "/uploads": "http://127.0.0.1:8080",
      "/outputs": "http://127.0.0.1:8080",
    },
  },
});
