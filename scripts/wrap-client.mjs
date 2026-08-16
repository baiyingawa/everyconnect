import { readFile, rm, writeFile } from 'node:fs/promises'

const input = new URL('../lib/.client-build/client.js', import.meta.url)
const output = new URL('../lib/client.js', import.meta.url)
const source = await readFile(input, 'utf8')

const wrapped = `window.__ModuleLoader__.load({ id: "everyconnect", factory: (require) => {
\tvar module = { exports: {} };
\tvar exports = module.exports;
${source}
\treturn module.exports;
\t}
});
`

await writeFile(output, wrapped, 'utf8')
await rm(new URL('../lib/.client-build', import.meta.url), { recursive: true, force: true })
