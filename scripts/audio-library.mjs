import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function scanAudio(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && /\.m4a$/i.test(entry.name))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'tr'))
    .map(name => ({ label: name.replace(/\.m4a$/i, ''), url: `./assets/audio/${encodeURIComponent(name)}` }));
}

export function audioLibrary() {
  const moduleName = 'virtual:audio-library', resolved = '\0' + moduleName;
  let directory;
  return {
    name: 'local-m4a-library',
    configResolved(config) { directory = path.join(config.publicDir, 'assets/audio'); },
    resolveId(id) { if (id === moduleName) return resolved; },
    async load(id) { if (id === resolved) return `export default ${JSON.stringify(await scanAudio(directory))};`; },
    configureServer(server) {
      server.watcher.add(directory);
      let timer;
      const refresh = file => {
        if (path.dirname(file) !== directory || !/\.m4a$/i.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const module = server.moduleGraph.getModuleById(resolved);
          if (module) server.moduleGraph.invalidateModule(module);
          server.ws.send({ type: 'full-reload', path: '*' });
        }, 300);
      };
      server.watcher.on('add', refresh).on('unlink', refresh).on('change', refresh);
      server.httpServer?.once('close', () => {
        clearTimeout(timer);
        server.watcher.off('add', refresh).off('unlink', refresh).off('change', refresh);
      });
    },
  };
}
