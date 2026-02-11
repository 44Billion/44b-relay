import { GenericContainer, Wait } from 'testcontainers'
import { addToCleanup } from '#helpers/process.js'

let container

export async function globalSetup () {
  // Set Docker Host for Podman
  if (!process.env.DOCKER_HOST) {
    const uid = process.getuid ? process.getuid() : 1000
    process.env.DOCKER_HOST = `unix:///run/user/${uid}/podman/podman.sock`
  }

  console.log('Starting Global Meilisearch Container...')
  container = await new GenericContainer('getmeili/meilisearch:v1.35.1')
    .withExposedPorts(7700)
    .withEnvironment({
      MEILI_NO_ANALYTICS: 'true'
    })
    .withWaitStrategy(Wait.forHttp('/health', 7700).withStartupTimeout(40000))
    .start()

  addToCleanup(async () => {
    console.log('Stopping Meilisearch Container...')
    await container.stop()
  })

  const containerHost = `http://${container.getHost()}:${container.getMappedPort(7700)}`
  console.log(`Global Meilisearch Container started at ${containerHost}`)

  // Expose env vars to test processes
  process.env.MDB_HOST = containerHost
  process.env.MDB_API_KEY = 'masterKey'
  process.env.NODE_ENV = 'test'

  // Return teardown function
  return async () => {
    console.log('Stopping Global Meilisearch Container...')
    await container.stop()
  }
}

export async function globalTeardown () {
  console.log('Stopping Global Meilisearch Container...')
  await container.stop()
}
