#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const Observable = require('baconjs')
const Promise = require('bluebird')
const R = require('ramda')
const globToRegExp = R.curry(require('glob-to-regexp'))
const _ = R.__

const readFileAsync = R.curryN(2, Promise.promisify(fs.readFile))(_, 'utf8')
const readdirAsync = R.curryN(2, Promise.promisify(fs.readdir))(_, 'utf8')
const statAsync = R.curryN(1, Promise.promisify(fs.stat))

const {
    always, T, identity, not, flip,
    call, pipe, compose,
    either, ifElse, cond,
    then, otherwise,
    length, map, filter, forEach, drop, append, partition,
    anyPass, includes,
    divide, max, equals,
    test, startsWith, split, trim,
    prop, invoker, thunkify
} = R

function readFirstLineAsync(filePath, encoding='utf8') {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(filePath, encoding)
            .on('error', reject)
        readline.createInterface({input: readStream})
            .on('line', line => {
                readStream.close()
                resolve(line)
            })
    })
}

const globMatch = compose(
    anyPass,
    map(compose(test, globToRegExp(_, {flags: 'i', extended: true})))
)
const flatMapWithConcurrencyLimit = invoker(2, 'flatMapWithConcurrencyLimit')
const flatMapError = invoker(1, 'flatMapError')
const concurrencyLimit = compose(max(4), Math.floor, divide(_, 8), length)(os.cpus())

const getBackupPathsReactive = pipe(
    Observable.fromPromise,
    flatMapWithConcurrencyLimit(1, ifElse(
        compose(equals('ignore'), prop('policy')),
        always(Observable.never()),
        ({dir, policy, ignorePatterns}) => call(pipe(
            thunkify(readdirAsync)(dir),
            Observable.fromPromise,
            flatMapError(always(Observable.never())),
            flatMapWithConcurrencyLimit(1, pipe(
                filter(compose(not, globMatch(ignorePatterns))),
                map(pipe(
                    base => ({dir, base}),
                    path.format,
                    path.normalize
                )),
                filter(compose(not, globMatch(ignorePatterns))),
                Observable.fromArray
            )),
            flatMapWithConcurrencyLimit(concurrencyLimit, fullPath => call(pipe(
                thunkify(statAsync)(fullPath),
                then(pipe(
                    stats => ({isFile: stats.isFile(), isDirectory: stats.isDirectory()}),
                    stats => ({fullPath, stats})
                )),
                Observable.fromPromise,
                flatMapError(always(Observable.never()))
            ))),
            flatMapWithConcurrencyLimit(concurrencyLimit, cond([
                [R.path(['stats', 'isFile']),       compose(Observable.once, prop('fullPath'))],
                [R.path(['stats', 'isDirectory']),  compose(R.curry(getBackupPaths)(_, policy, ignorePatterns), prop('fullPath'))],
                [T,                                 always(Observable.never())]
            ]))
        ))
    ))
)

const getBackupPolicyAsync = pipe(
    R.curryN(2, path.join)(_, '.backuppolicy'),
    readFirstLineAsync,
    then(pipe(
        trim,
        ifElse(includes(_, ['leaf', 'branch', 'ignore']), identity, always('leaf'))
    )),
    otherwise(always('leaf'))
)
const getIgnorePatternsAsync = pipe(
    R.curryN(2, path.join)(_, '.backupignore'),
    readFileAsync,
    then(pipe(
        split(/\r?\n/),
        map(trim),
        filter(compose(not, startsWith('#')))
    )),
    otherwise(always([]))
)
const resolvePolicy = ifElse(
    compose(equals('branch'), prop('parentPolicy')),
    compose(getBackupPolicyAsync, prop('dir')),
    compose(Promise.resolve, prop('parentPolicy'))
)
const resolveIgnorePatterns = ifElse(
    compose(equals('branch'), prop('parentPolicy')),
    compose(getIgnorePatternsAsync, prop('dir')),
    compose(Promise.resolve, prop('parentIgnorePatterns'))
)

function getBackupPaths(dir, parentPolicy='branch', parentIgnorePatterns=[]) {
    return getBackupPathsReactive(Promise.join(
        resolvePolicy({dir, parentPolicy}),
        resolveIgnorePatterns({dir, parentPolicy, parentIgnorePatterns}),
        (policy, ignorePatterns) => ({dir, policy, ignorePatterns})
    ))
}

const runningAsMain = require.main == module && !module.parent
if (runningAsMain) {
    const console = require('console')
    const process = require('process')

    if (length(process.argv) < 3)
        return console.error('no dirpath given')

    const getOpts = compose(partition(startsWith('--')), drop(2))
    const eagerLogging = either(compose(not, includes('--quiet')), includes('--verbose'))

    const [opts, [dir]] = getOpts(process.argv)
    const observable = getBackupPaths(dir)
    if (eagerLogging(opts))
        observable.onValue(console.log)
    else
        observable
            .reduce([], flip(append))
            .toPromise(Promise)
            .then(forEach(console.log))
} else {
    module.exports = getBackupPaths
}
