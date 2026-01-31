#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const env = { ...process.env }

const url = new URL(process.env.DATABASE_URL)
const target = url.protocol === 'file:' && url.pathname

// restore database if not present and replica exists
const newDb = target && !fs.existsSync(target)
if (newDb && process.env.BUCKET_NAME) {
  await exec(`npx litestream restore -config litestream.yml -if-replica-exists ${target}`)
}

// prepare database
await exec('npx prisma migrate deploy')

// launch application
if (process.env.BUCKET_NAME) {
  await exec(`npx litestream replicate -config litestream.yml -exec ${JSON.stringify(process.argv.slice(2).join(' '))}`)
} else {
  await exec(process.argv.slice(2).join(' '))
}

function exec(command) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env })
  return new Promise((resolve, reject) => {
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed rc=${code}`))
      }
    })
  })
}
