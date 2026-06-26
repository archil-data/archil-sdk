import { createDatabase, getDatabase } from '../../src/index.js'
import * as archil from "disk";

if (!process.env.ARCHIL_API_KEY) {
  throw new Error('ARCHIL_API_KEY environment variable is not set')
}
if (!process.env.ARCHIL_DISK_ID) {
  throw new Error('ARCHIL_DISK_ID environment variable is not set')
}

archil.configure({
  apiKey: process.env.ARCHIL_API_KEY,
  region: 'aws-us-east-1',
  baseUrl: process.env.ARCHIL_BASE_URL,
})


const disk = await archil.getDisk(process.env.ARCHIL_DISK_ID)

const USERS = 5
const users = Array.from({ length: USERS }, (_, i) => ({
  name: `User ${i}`,
  email: `user${i}@example.com`,
}))

await Promise.all(users.map(async (user) => {
  console.log(`Creating database for ${user.name}...`)
  await createDatabase(disk, `${user.name.replace(' ', '_')}/db.sqlite`)
  console.log(`Created database for ${user.name}...`)
}))

// concurrent insertion of users across multiple databases
await Promise.all(users.map(async (user) => {
  const db = await getDatabase(disk, `${user.name.replace(' ', '_')}/db.sqlite`)
  const transaction = await db.transaction([
    db.write`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`.run(),
    db.write`INSERT INTO users (name, email) VALUES (${user.name}, ${user.email})`.run()
  ])
  console.log(transaction)
  await new Promise((resolve) => setTimeout(resolve, 2000))
}))

// concurrent reads
const db = await getDatabase(disk, `${users[0].name.replace(' ', '_')}/db.sqlite`)
console.log(await db.write`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`.run())
console.log(await Promise.all([
  db.read`SELECT * FROM users`.run(),
  db.read`SELECT * FROM users`.run()
]))

// concurrent writes
console.log(await Promise.all([
  db.write`INSERT INTO users (name, email) VALUES ('User 5', 'user5@example.com')`.run(),
  db.write`INSERT INTO users (name, email) VALUES ('User 6', 'user6@example.com')`.run()
]))
