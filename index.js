#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const Bacon = require('baconjs')
const Promise = require('bluebird')
const R = require('ramda')
const _ = R.__

const globToRegExp = R.curry(require('glob-to-regexp'))

const readdirAsync = Promise.promisify(fs.readdir)
const statAsync = Promise.promisify(fs.stat)
const readFileAsync = Promise.promisify(fs.readFile)
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
    return readFirstLineAsync(policyfile)
        .then(R.pipe(
            R.trim,
            val => isValidPolicy(val) ? val : 'leaf'
        ))
        .catch(R.always('leaf'))
}

function getIgnorePatternsAsync(dir) {
    const patternfile = path.join(dir, '.backupignore')
    return readFileAsync(patternfile, 'utf8')
        .then(R.pipe(
            R.split(/\r?\n/),
            R.map(R.trim),
            R.filter(R.compose(R.not, R.startsWith('#')))
        ))
        .catch(R.always([]))
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
    const globMatch = R.compose(
        R.anyPass,
        R.map(R.compose(R.test, globToRegExp(_, {flags: 'i', extended: true})))
    )

    return Promise.join(policyP, patternsP, (policy, ignorepatterns) =>
        policy == 'ignore' ? Promise.resolve([]) :
        readdirAsync(dir)
            .catch(R.always([]))
            .then(R.pipe(
                R.filter(R.compose(R.not, globMatch(ignorepatterns))),
                R.map(R.pipe(
                    base => ({dir, base}),
                    path.format,
                    path.normalize
                )),
                R.filter(R.compose(R.not, globMatch(ignorepatterns)))
            ))
            .then(R.compose(Promise.all, R.map(
                fullpath => R.pipe(
                    statAsync,
                    R.otherwise(R.always({isFile: R.F, isDirectory: R.F})),
                    R.then(stats => ({fullpath, stats}))
                )(fullpath)
            )))
            .then(R.pipe(
                R.map(({fullpath, stats}) =>
                    stats.isFile() ? Promise.resolve([fullpath]) :
                    stats.isDirectory() ? getBackupPathsAsync(fullpath, policy, ignorepatterns) :
                    Promise.resolve([])
                ),
                Promise.all,
                R.then(R.flatten)
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
    const globMatch = R.compose(
        R.anyPass,
        R.map(R.compose(R.test, globToRegExp(_, {flags: 'i', extended: true})))
    )

    return Bacon.fromPromise(
        Promise.join(policyP, patternsP, (policy, ignorepatterns) =>
            ({policy, ignorepatterns}))
    )
    .flatMap(({policy, ignorepatterns}) =>
        policy == 'ignore' ? Bacon.never() :
        Bacon.fromPromise(readdirAsync(dir))
            .flatMap(R.pipe(
                R.filter(R.compose(R.not, globMatch(ignorepatterns))),
                R.map(R.pipe(
                    base => ({dir, base}),
                    path.format,
                    path.normalize
                )),
                R.filter(R.compose(R.not, globMatch(ignorepatterns))),
                Bacon.fromArray
            ))
            .flatMap(fullpath => R.pipe(
                statAsync,
                R.then(stats => ({fullpath, stats})),
                Bacon.fromPromise
            )(fullpath))
            .flatMap(({fullpath, stats}) =>
                stats.isFile() ? Bacon.once(fullpath) :
                stats.isDirectory() ? getBackupPathsRx(fullpath, policy, ignorepatterns) :
                Bacon.never()
            )
    )
}

Object.assign(module.exports, {
    getBackupPolicyAsync,
    getIgnorePatternsAsync,
    getBackupPathsAsync,
    getBackupPathsRx
})

const runningAsMain = require.main == module && !module.parent
if (runningAsMain) {
    if (process.argv.length < 3)
        return console.error('no dirpath given')
    const [,, dir, ...opts] = process.argv

    const useAsync = opts.includes('--async') && !opts.includes('--reactive')

    if (useAsync)
        getBackupPathsAsync(dir)
            .then(paths => paths.forEach(path => console.log(path)))
    else
        getBackupPathsRx(dir)
            .onValue(console.log)
}
