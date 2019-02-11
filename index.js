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

const {
    always, identity, not, F, flip,
    call, pipe, compose,
    then, otherwise,
    map, filter, forEach, flatten, drop, append, partition,
    anyPass, includes,
    test, startsWith, split, trim,
    invoker, mergeLeft
} = R

const globMatch = compose(
    anyPass,
    map(compose(test, globToRegExp(_, {flags: 'i', extended: true})))
)

function readFirstLineAsync(filepath, encoding='utf8') {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(filepath, encoding)
            .on('error', reject)
        readline.createInterface({input: readStream})
            .on('line', line => {
                readStream.close()
                resolve(line)
            })
    })
}

function getBackupPolicyAsync(dir) {
    const policyfile = path.join(dir, '.backuppolicy')
    const isValidPolicy = flip(includes)(['leaf', 'branch', 'ignore'])
    return call(pipe(
        always(policyfile),
        readFirstLineAsync,
        then(pipe(
            trim,
            val => isValidPolicy(val) ? val : 'leaf'
        )),
        otherwise(always('leaf'))
    ))
}

function getIgnorePatternsAsync(dir) {
    const patternfile = path.join(dir, '.backupignore')
    return call(pipe(
        always(patternfile),
        readFileAsync,
        then(pipe(
            split(/\r?\n/),
            map(trim),
            filter(compose(not, startsWith('#')))
        )),
        otherwise(always([]))
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
        then,
        otherwise,
        identity,
        mapFn => pipe(
            map(mapFn),
            Promise.all,
            then(flatten)
        )
    ] : [
        compose(Bacon.fromPromise, Promise.resolve),
        Bacon.never(),
        invoker(1, 'flatMap'),
        invoker(1, 'flatMapError'),
        Bacon.fromArray,
        identity
    ]

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

        return call(pipe(
            always(policyAndPatternsP),
            monadId,
            monadBind(({policy, ignorepatterns}) =>
                policy == 'ignore' ? monadZero :
                call(pipe(
                    always(dir),
                    readdirAsync,
                    monadId,
                    monadBindErr(always(monadZero)),
                    monadBind(pipe(
                        filter(compose(not, globMatch(ignorepatterns))),
                        map(pipe(
                            base => ({dir, base}),
                            path.format,
                            path.normalize
                        )),
                        filter(compose(not, globMatch(ignorepatterns)))
                    )),
                    monadBind(spread),
                    monadBind(
                        spreadMap(
                            fullpath => call(pipe(
                                always(fullpath),
                                statAsync,
                                otherwise(always({isFile: F, isDirectory: F})),
                                then(stats => ({fullpath, stats})),
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
        return mergeLeft(monad, {
            then: variant == 'async' ?
                flip(then)(monad) :
                flip(then)(call(pipe(
                    always(monad),
                    invoker(2, 'reduce')([], flip(append)),
                    invoker(1, 'toPromise')(Promise)
                ))),
            onValue: variant == 'reactive' ?
                flip(invoker(1, 'onValue'))(monad) :
                compose(flip(then)(monad), forEach)
        })
    }
}

function getBackupPathsAsync(dir, parentpolicy='branch', parentignorepatterns=[]) {
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
    return Promise.join(policyP, patternsP, (policy, ignorepatterns) =>
        policy == 'ignore' ? Promise.resolve([]) :
        call(pipe(
            always(dir),
            readdirAsync,
            otherwise(always([])),
            then(pipe(
                filter(compose(not, globMatch(ignorepatterns))),
                map(pipe(
                    base => ({dir, base}),
                    path.format,
                    path.normalize
                )),
                filter(compose(not, globMatch(ignorepatterns)))
            )),
            then(pipe(
                map(fullpath => call(pipe(
                    always(fullpath),
                    statAsync,
                    otherwise(always({isFile: F, isDirectory: F})),
                    then(stats => ({fullpath, stats}))
                ))),
                Promise.all
            )),
            then(pipe(
                map(({fullpath, stats}) =>
                    stats.isFile() ? Promise.resolve([fullpath]) :
                    stats.isDirectory() ? getBackupPathsAsync(fullpath, policy, ignorepatterns) :
                    Promise.resolve([])
                ),
                Promise.all,
                then(flatten)
            ))
        ))
    )
}

function getBackupPathsRx(dir, parentpolicy='branch', parentignorepatterns=[]) {
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

    const flatMap = invoker(1, 'flatMap')
    const flatMapError = invoker(1, 'flatMapError')

    return call(pipe(
        always(policyAndPatternsP),
        Bacon.fromPromise,
        flatMap(({policy, ignorepatterns}) =>
            policy == 'ignore' ? Bacon.never() :
            call(pipe(
                always(dir),
                readdirAsync,
                Bacon.fromPromise,
                flatMapError(always(Bacon.never())),
                flatMap(pipe(
                    filter(compose(not, globMatch(ignorepatterns))),
                    map(pipe(
                        base => ({dir, base}),
                        path.format,
                        path.normalize
                    )),
                    filter(compose(not, globMatch(ignorepatterns))),
                    Bacon.fromArray
                )),
                flatMap(fullpath => call(pipe(
                    always(fullpath),
                    statAsync,
                    otherwise(always({isFile: F, isDirectory: F})),
                    then(stats => ({fullpath, stats})),
                    Bacon.fromPromise
                ))),
                flatMap(({fullpath, stats}) =>
                    stats.isFile() ? Bacon.once(fullpath) :
                    stats.isDirectory() ? getBackupPathsRx(fullpath, policy, ignorepatterns) :
                    Bacon.never()
                )
            ))
        )
    ))
}

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
    const args = drop(2, process.argv)
    const [opts, [dir]] = partition(startsWith('--'), args)

    const useReactive = !opts.includes('--async') || opts.includes('--reactive')
    const eagerLogging = !opts.includes('--silent') || opts.includes('--verbose')
    // silent (non-eager logging) means dump all results at the very end,
    //      i.e., complete the whole list before starting printing
    // verbose (eager logging) means dump results immediately,
    //      i.e., immediately print partial results
    // --reactive supports both eager and non-eager logging
    // --async doesn't support eager logging (go figure)

    const useUnifiedImpl = opts.includes('--unified')
    if (useUnifiedImpl) {
        const variant = useReactive ? 'reactive' : 'async'
        const monad = getBackupPaths(variant)(dir)
        return eagerLogging ?
            monad.onValue(console.log) :
            monad.then(forEach(console.log))
    }

    if (!useReactive) {
        return getBackupPathsAsync(dir)
            .then(forEach(console.log))
    }

    return eagerLogging ?
        getBackupPathsRx(dir)
            .onValue(console.log) :
        getBackupPathsRx(dir)
            .reduce([], flip(append))
            .toPromise(Promise)
            .then(forEach(console.log))
}
