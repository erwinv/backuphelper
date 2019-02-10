#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const Bacon = require('baconjs')
const Promise = require('bluebird')
const R = require('ramda')
const globToRegExp = R.curry(require('glob-to-regexp'))
const _ = R.__

const readdirAsync = Promise.promisify(fs.readdir)
const statAsync = Promise.promisify(fs.stat)
const readFileAsync = R.curryN(2, Promise.promisify(fs.readFile))(_, 'utf8')

const readFirstLineAsync = (filepath, encoding='utf8') => new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filepath, encoding)
        .on('error', reject)
    readline.createInterface({input: readStream})
        .on('line', line => {
            readStream.close()
            resolve(line)
        })
})

function getBackupPolicyAsync(dir) {
    const policyfile = path.join(dir, '.backuppolicy')
    const isValidPolicy = R.flip(R.includes)(['leaf', 'branch', 'ignore'])
    return R.call(R.pipe(
        R.always(policyfile),
        readFirstLineAsync,
        R.then(R.pipe(
            R.trim,
            val => isValidPolicy(val) ? val : 'leaf'
        )),
        R.otherwise(R.always('leaf'))
    ))
}

function getIgnorePatternsAsync(dir) {
    const patternfile = path.join(dir, '.backupignore')
    return R.call(R.pipe(
        R.always(patternfile),
        readFileAsync,
        R.then(R.pipe(
            R.split(/\r?\n/),
            R.map(R.trim),
            R.filter(R.compose(R.not, R.startsWith('#')))
        )),
        R.otherwise(R.always([]))
    ))
}

function getBackupPaths(variant='reactive') {
    const [
        monadId,
        monadZero,
        monadBind,
        monadBindErr,
        spread,
        spreadMap
    ] =
    variant == 'async' ? [
        Promise.resolve,
        Promise.resolve([]),
        R.then,
        R.otherwise,
        R.identity,
        mapFn => R.pipe(
            R.map(mapFn),
            Promise.all,
            R.then(R.flatten)
        )
    ] : [
        R.compose(Bacon.fromPromise, Promise.resolve),
        Bacon.never(),
        R.invoker(1, 'flatMap'),
        R.invoker(1, 'flatMapError'),
        Bacon.fromArray,
        R.identity
    ]

    const globMatch = R.compose(
        R.anyPass,
        R.map(R.compose(R.test, globToRegExp(_, {flags: 'i', extended: true})))
    )

    function _getBackupPaths(dir, parentpolicy='branch', parentignorepatterns=[]) {
        const policyP = Promise.resolve(
            parentpolicy == 'branch' ?
                getBackupPolicyAsync(dir) :
                parentpolicy
        )
        const patternsP = Promise.resolve(
            parentpolicy == 'branch' ?
                getIgnorePatternsAsync(dir) :
                parentignorepatterns
        )
        const policyAndPatternsP = Promise.join(policyP, patternsP,
            (policy, ignorepatterns) => ({policy, ignorepatterns}))

        return R.call(R.pipe(
            R.always(policyAndPatternsP),
            monadId,
            monadBind(({policy, ignorepatterns}) =>
                policy == 'ignore' ? monadZero :
                R.call(R.pipe(
                    R.always(dir),
                    readdirAsync,
                    monadId,
                    monadBindErr(R.always(monadZero)),
                    monadBind(R.pipe(
                        R.filter(R.compose(R.not, globMatch(ignorepatterns))),
                        R.map(R.pipe(
                            base => ({dir, base}),
                            path.format,
                            path.normalize
                        )),
                        R.filter(R.compose(R.not, globMatch(ignorepatterns)))
                    )),
                    monadBind(spread),
                    monadBind(
                        spreadMap(
                            fullpath => R.call(R.pipe(
                                R.always(fullpath),
                                statAsync,
                                R.otherwise(R.always({isFile: R.F, isDirectory: R.F})),
                                R.then(stats => ({fullpath, stats})),
                                monadId
                            ))
                        )
                    ),
                    monadBind(
                        spreadMap(
                            ({fullpath, stats}) =>
                                stats.isFile() ? monadId(fullpath) :
                                stats.isDirectory() ? _getBackupPaths(fullpath, policy, ignorepatterns) :
                                monadZero
                        )
                    )
                ))
            )
        ))
    }
    return dir => {
        const monad = _getBackupPaths(dir)
        return R.mergeLeft(monad, {
            then: variant == 'async' ?
                R.flip(R.then)(monad) :
                R.flip(R.then)(monad.reduce([], R.flip(R.append)).toPromise(Promise)),
            onValue: variant == 'reactive' ?
                R.flip(R.invoker(1, 'onValue'))(monad) :
                R.compose(R.flip(R.then)(monad), R.forEach)
        })
    }
}

const getBackupPathsAsync = getBackupPaths('async')
const getBackupPathsRx = getBackupPaths('reactive')

Object.assign(module.exports, {
    getBackupPolicyAsync,
    getIgnorePatternsAsync,
    getBackupPathsAsync,
    getBackupPathsRx,
    getBackupPaths
})

const runningAsMain = require.main == module && !module.parent
if (runningAsMain) {
    if (process.argv.length < 3)
        return console.error('no dirpath given')
    const args = R.drop(2, process.argv)
    const [opts, [dir]] = R.partition(R.startsWith('--'), args)

    const useReactive = !opts.includes('--async') || opts.includes('--reactive')
    const eagerLogging = !opts.includes('--silent') || opts.includes('--verbose')
    // silent (non-eager logging) means dump all results at the very end,
    //      i.e., complete the whole list before starting printing
    // verbose (eager logging) means dump results immediately,
    //      i.e., start printing partial list
    // --reactive supports both eager and non-eager logging
    // --async doesn't support eager logging (go figure)

    const variant = useReactive ? 'reactive' : 'async'
    const monad = getBackupPaths(variant)(dir)
    if (eagerLogging)
        monad.onValue(console.log)
    else
        monad.then(R.forEach(console.log))
}
