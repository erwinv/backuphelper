#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const Observable = require('baconjs')
const Promise = require('bluebird')
const R = require('ramda')
const readdir = require('readdir-enhanced')

const _ = R.__
const globToRegExp = R.curry(require('glob-to-regexp'))(_, {extended: true})
const readFileAsync = R.curryN(2, Promise.promisify(fs.readFile))(_, 'utf8')

const {
    always, T, identity, not, flip,
    call, pipe, compose,
    either, ifElse, cond,
    then, otherwise,
    length, map, filter, forEach, drop, append, partition,
    anyPass, includes,
    equals, startsWith, test, split, trim, join,
    assoc, prop, invoker, thunkify
} = R

function readdirReactive(dir, filter) {
    const dirStream = readdir.stream.stat(dir, {filter, basePath: dir})
    const endStream = Observable.fromEvent(dirStream, 'end').take(1)
    const errorStream = Observable.fromEvent(dirStream, 'error')
        .map(error => new Observable.Error(error))
    const dataStream = Observable.fromEvent(dirStream, 'data')
    return dataStream.merge(errorStream).takeUntil(endStream)
}

const globMatch = compose(anyPass, map(compose(test, globToRegExp)))
const ignoreFilter = ignorePatterns => compose(
    not, globMatch(ignorePatterns), path.basename, prop('path')
)
const flatMap = invoker(1, 'flatMap')
const flatMapWithConcurrencyLimit = invoker(2, 'flatMapWithConcurrencyLimit')
const numCores = length(os.cpus())

const getBackupPathsReactive = flatMap(
    ifElse(
        compose(equals('ignore'), prop('policy')),
        always(Observable.never()),

        ({dir, ignorePatterns, recursiveCall}) => call(pipe(
            thunkify(readdirReactive)(dir, ignoreFilter(ignorePatterns)),
            flatMap(Observable.try(stats => ({
                path: stats.path,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory()
            }))),
            flatMapWithConcurrencyLimit(numCores, cond([
                [prop('isFile'),        compose(Observable.once, prop('path'))],
                [prop('isDirectory'),   compose(recursiveCall, prop('path'))],
                [T,                     always(Observable.never())]
            ]))
        ))
    )
)

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
    const dirPolicyIgnorePatternsAndRecursiveFn = Promise.join(
        resolvePolicy({dir, parentPolicy}),
        resolveIgnorePatterns({dir, parentPolicy, parentIgnorePatterns}),
        (policy, ignorePatterns) => assoc(
            'recursiveCall', dir => getBackupPaths(dir, policy, ignorePatterns),
            {dir, policy, ignorePatterns}
        )
    )
    return getBackupPathsReactive(Observable.fromPromise(dirPolicyIgnorePatternsAndRecursiveFn))
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
        observable
            .bufferWithCount(64)
            .map(join('\n'))
            .onValue(console.log)
    else
        observable
            .reduce([], flip(append))
            .toPromise(Promise)
            .then(forEach(console.log))
} else {
    module.exports = getBackupPaths
}
