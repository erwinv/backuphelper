module.exports = {
    "env": {
        "browser": false,
        "commonjs": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "ecmaVersion": 6
    },
    "rules": {
        "indent": [
            "error",
            4,
            {
                "flatTernaryExpressions": true
            }
        ],
        "linebreak-style": [
            "error",
            "unix"
        ],
        "quotes": [
            "error",
            "single"
        ],
        "semi": [
            "error",
            "never"
        ]
    }
};