Automatically accepts or declines Trade Broker negotiations. 

Settings can be configured by editing `index.js` (after disabing auto-update in module.json file)


Changes of this version:

new command `nretry` - retries last suggested deal  

new variables: `AUTO_REJECT_TROLLS` and `AUTO_REJECT_CHANCE`

new randomized timeouts `ACTION_DELAY_TIMEOUT_MS` and `ACTION_DELAY_TIMEOUT_SHORT_MS`

support for delayed deal suggestions via other modules

fixes for command and bigint updates and the gui

text `Deal successful` when it is successful