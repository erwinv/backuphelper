#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const Observable = require('baconjs')
const Promise = require('bluebird')
const R = require('ramda')
const globToRegExp = R.curry(require('glob-to-regexp'))
const _ = R.__

const readdirAsync = Promise.promisify(fs.readdir)
const statAsync = Promise.promisify(fs.stat)
const readFileAsync = R.curryN(2, Promise.promisify(fs.readFile))(_, 'utf8')

const {
    always, not, flip,
    call, pipe, compose,
    then, otherwise,
    map, filter, forEach, drop, append, partition,
    anyPass, includes,
    test, startsWith, split, trim,
    invoker
} = R

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

function getBackupPathsReactive(dir, parentpolicy='branch', parentignorepatterns=[]) {
    const globMatch = compose(
        anyPass,
        map(compose(test, globToRegExp(_, {flags: 'i', extended: true})))
    )

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

    const flatMapWCL = invoker(2, 'flatMapWithConcurrencyLimit')
    const flatMapError = invoker(1, 'flatMapError')

    return call(pipe(
        always(policyAndPatternsP),
        Observable.fromPromise,
        flatMapWCL(1, ({policy, ignorepatterns}) =>
            policy == 'ignore' ? Observable.never() :
            call(pipe(
                always(dir),
                readdirAsync,
                Observable.fromPromise,
                flatMapError(always(Observable.never())),
                flatMapWCL(1, pipe(
                    filter(compose(not, globMatch(ignorepatterns))),
                    map(pipe(
                        base => ({dir, base}),
                        path.format,
                        path.normalize
                    )),
                    filter(compose(not, globMatch(ignorepatterns))),
                    Observable.fromArray
                )),
                flatMapWCL(3, fullpath => call(pipe(
                    always(fullpath),
                    statAsync,
                    then(stats => ({fullpath, stats})),
                    Observable.fromPromise,
                    flatMapError(always(Observable.never()))
                ))),
                flatMapWCL(3, ({fullpath, stats}) =>
                    stats.isFile() ? Observable.once(fullpath) :
                    stats.isDirectory() ? getBackupPathsReactive(fullpath, policy, ignorepatterns) :
                    Observable.never()
                )
            ))
        )
    ))
}

Object.assign(module.exports, {
    getBackupPolicyAsync,
    getIgnorePatternsAsync,
    getBackupPathsReactive
})

const runningAsMain = require.main == module && !module.parent
if (runningAsMain) {
    const console = require('console')
    const process = require('process')

    if (process.argv.length < 3)
        return console.error('no dirpath given')
    const args = drop(2, process.argv)
    const [opts, [dir]] = partition(startsWith('--'), args)

    const eagerLogging = !opts.includes('--quiet') || opts.includes('--verbose')

    const observable = getBackupPathsReactive(dir)
    if (eagerLogging)
        observable.onValue(console.log)
    else
        observable
            .reduce([], flip(append))
            .toPromise(Promise)
            .then(forEach(console.log))
}
