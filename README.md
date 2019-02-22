### Overview

- Input: root directory/path to analyze
- Output: list of files to backup according to policy file and ignore file

### Download

```shell
$ git clone https://github.com/eruwinu/backuphelper.git
```

### Install dependencies

```shell
$ cd backuphelper
backuphelper $ npm install
```

### Usage

```shell
backuphelper $ node index.js /path/to/analyze
```

### Options

- `--silent`|`--verbose`

Default `--verbose`

### Configuration files

- `.backuppolicy`
  - branch|leaf|ignore
- `.backupignore`
  - glob pattern, 1 per line

Configuration files can be created on subdirectories (not limited to root directory).
