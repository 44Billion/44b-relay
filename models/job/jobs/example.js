export async function run () {

}

const config = {
  key: 'example',
  frequency: 60 * 60, // seconds; every 1 hour
  maxDuration: 5 * 60, // seconds; 5 minutes
  // If false, multiple workers can run this job simultaneously
  // and don't need to acquire a lock on the DB side
  shouldUseLock: true,
  // If true and shouldUseLock=true too,
  // the worker acts only as a watchdog:
  // it won't start the job based on frequency,
  // but it will restart it if it stalls or runs too long.
  manual: false,
  run
}

export default config
