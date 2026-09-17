import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const hmrPort = env.HMR_PORT ? parseInt(env.HMR_PORT, 10) : 24678;
  const serverPort = env.PORT ? parseInt(env.PORT, 10) : 3000;
  // Lets the dev server be opened over the tailnet by machine name (e.g. "bluefin"),
  // which Vite otherwise refuses as an unrecognized Host header.
  const allowedHosts = env.DEV_ALLOWED_HOSTS
    ? env.DEV_ALLOWED_HOSTS.split(',')
        .map((host) => host.trim())
        .filter((host) => host.length > 0)
    : undefined;

  return {
    plugins: [tailwindcss(), reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      port: serverPort,
      hmr: { port: hmrPort },
      allowedHosts,
    },
  };
});
