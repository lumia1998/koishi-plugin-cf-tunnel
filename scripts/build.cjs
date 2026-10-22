const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')

async function main() {
  const root = resolve(__dirname, '..')
  const args = [require.resolve('typescript/bin/tsc'), '-p', root]
  if (process.env.KOISHI_DEV_ROOT) {
    const modules = join(process.env.KOISHI_DEV_ROOT, 'node_modules')
    args.push('--baseUrl', modules, '--typeRoots', join(modules, '@types'))
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
