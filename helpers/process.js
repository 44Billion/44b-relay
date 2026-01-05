const addToCleanup = (() => {
  const options = {
    justLogUnhandledRejection: true,
    forceQuitAfterSignalCount: 2,
    cleanupFunctionTimeout: 10000,
    cleanupFunctionsTimeout: 30000
  }
  const cleanupFns = []
  let isErrorBeingHandled = false

  function _addToCleanup (fn) {
    cleanupFns.push(fn)
  }

  let signalCount = 0
  function handleSignal (signal) {
    if (++signalCount === _addToCleanup.forceQuitAfterSignalCount) {
      console.log('Force quit!')
      process.exit(0)
    }
    if (!isErrorBeingHandled) {
      console.log(`Process ${process.pid} has been interrupted by a ${signal} signal`)
    }
    handleTermination()
  }

  async function handleTermination (err) {
    // e.g.: multiple ctrl+c or a promise rejection while already handling another error
    if (isErrorBeingHandled) return

    const { cleanupFunctionTimeout, cleanupFunctionsTimeout } = _addToCleanup
    isErrorBeingHandled = true
    const exitCode = err ? 1 : 0

    console.log(
      'Releasing',
      cleanupFns.length,
      err ? `resources due to error: ${err.stack}` : 'resources'
    )

    setTimeout(() => {
      console.log('Time\'s up for entire cleanup routine')
      process.exit(exitCode)
    }, cleanupFunctionsTimeout).unref()

    for (const cleanupFn of cleanupFns) {
      try {
        let timerId
        await Promise.race([
          Promise.resolve().then(() => cleanupFn()),
          new Promise(resolve => {
            timerId = setTimeout(() => {
              console.log('Time\'s up for 1 cleanup function')
              resolve()
            }, cleanupFunctionTimeout)
          })
        ]).then(ret => {
          clearTimeout(timerId)
          return ret
        })
      } catch (err) {
        console.log('Cleanup function error:', err)
      }
    }

    process.exit(exitCode)
  }

  ;[
    'SIGINT', // pm2
    'SIGTERM' // systemd
  ].forEach(v => {
    process.on(v, handleSignal)
  })
  process.on('uncaughtException', handleTermination)
  process.on('unhandledRejection', (reason, promise) => {
    if (_addToCleanup.justLogUnhandledRejection) {
      return console.log('Unhandled rejection at:', promise, 'reason:', reason)
    }
    handleTermination(reason)
  })

  return Object.assign(_addToCleanup, options)
})()

export { addToCleanup }
