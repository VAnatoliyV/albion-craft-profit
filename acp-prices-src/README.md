# acp-prices — your own price receiver

Listens on your machine, takes whatever `albiondata-client` sends with the `-p`
flag, and keeps it in a single file. It never sends anything out; the only
thing it fetches is the site itself, so it can serve it locally.

MIT licence, no external dependencies — Go standard library only.
(Russian version of this file: `README.ru.md`.)

## Building

    go build -o acp-prices .

For Apple Silicon, from any machine:

    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o acp-prices .

## Running

    ./acp-prices                 # listens on 127.0.0.1:7777
    ./acp-prices -lan            # open to your home network, to view from a phone
    ./acp-prices -port 7800      # another port
    ./acp-prices -reset          # wipe what has been collected
    ./acp-prices -data /path     # where to keep the price database

Point the collector at it like this:

    albiondata-client -p http://localhost:7777

Add `-d` if you want to switch off uploading to the public project as well, so
the prices stay only with you.

## Where the database goes

In this order:

1. the `-data` flag
2. the `AJ_DATA` environment variable
3. the directory next to the executable

The second one exists for bundling into an app: you cannot write inside a
signed bundle, so the app names its own data directory and the binary does not
have to be copied out.

## What it serves

* `/own.json`   — the prices collected so far; the site reads this
* `/status`     — what has been collected, in plain words
* `/`           — the site itself, downloaded and served locally

## A note on market locations

The market tag comes from the game and means the zone the character is standing
in, not the market the list came from. In Caerleon the zone flips between 3003,
3005 and 3006, so the panel and `/status` show which tags arrived and how many
times the tag changed. This cannot be fixed on the receiver side: watch the
counter and page through the lists in one spot.

## Licence

MIT, text in LICENSE. Take it, change it, pass it on, build it into your own app.
