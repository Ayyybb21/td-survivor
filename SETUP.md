# TD Survivor V2

## What changed
This version is a fuller prototype and is designed around a league of ANY size.

It includes:
- Player selection with one-use blocking
- Shared-style league standings prototype
- Commissioner control center
- Week locking
- Buyback recording
- Automatic pot update
- Weekly announcement generator + clipboard copy
- PWA install structure
- Google Apps Script backend starter

## Important
The browser demo still stores data locally. It is not yet the shared production league.

## Production architecture — still free
1. Google Sheet = database
2. Google Apps Script = API/backend
3. GitHub Pages = PWA hosting
4. NFL data feed = automatic TD grading
5. PWA = participant + commissioner interface

## Recommended participant model
Don't require complicated passwords initially. Give each participant a unique invite link/token:
https://yourapp.example/?player=abc123

The backend maps that token to the participant. The commissioner can revoke/regenerate a token.

## Next build
- Build the Google Sheet schema
- Implement Apps Script read/write endpoints
- Connect PWA to Apps Script
- Add participant invite management
- Add actual player list
- Add week-by-week pick validation
- Add one-buyback rule
- Add automated NFL TD grading
- Add announcement copy/share flow
- Add commissioner-only controls

## League size
No hard-coded maximum is planned. The interface should work for 10, 30, 50, 100+ participants. The practical limit will be the backend/API quotas rather than the UI.


## Current participant seed
This build includes 22 starting participants:

bb, Tay, Eddie, Brendan, Johnny, Jack, Timmy, Theresa, Ash, Rick, Drew, Byrne, Mac, Ed, Vincie, Big Vince, Dane, Gilchrist, Joe, Logan, Gabe, Vinny

The initial prize pool is calculated as 22 x $20 = $440.
Additional people can be added later without changing the app design.

A `participants_seed.csv` file is included for easy import into the Google Sheet backend.


## V4: owners and multiple plays

The data model now separates an OWNER/ACCOUNT from an ENTRY/PLAY.

Example:
- Account: Tay
- Play: Tay 1
- Play: Tay 2

Both plays sit under the same account, but each has its own:
- weekly pick
- used-player history
- alive/eliminated status
- one-time $10 buyback
- $20 entry fee / paid status

The commissioner can add additional plays to an existing owner at any time.

## How to preview it

The ZIP is source code, not a published app.

On a computer:
1. Download and unzip the folder.
2. Open `index.html` in Chrome, Safari, or Edge.

For it to work like a true installable iPhone PWA, it needs to be published to an HTTPS web address. A free host such as GitHub Pages, Cloudflare Pages, Netlify, or Vercel can do that. Once hosted, participants simply open the link in Safari and choose **Add to Home Screen**.
