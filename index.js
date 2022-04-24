const AUTO_ACCEPT_THRESHOLD		= 100,			// Automatically accepts offers for *equal or more than* the specified amount (0 to disable).
	AUTO_REJECT_THRESHOLD		= 100,			/*	Automatically declines offers for *less* than the specified amount (or AUTO_ACCEPT_THRESHOLD).
													Example: 75 will decline offers for less than 75% of the asking price (0 to disable).
												*/
	AUTO_REJECT_TROLLS			= 200,			// reject deals with offer price more than % of the asked price
	AUTO_REJECT_CHANCE			= 15,			// only bots reject everything, and we'r humans... right?
	UNATTENDED_MANUAL_NEGOTIATE	= true,		/* Allows the user to click the Accept button once, and the negotiation will be handled automatically.
													Warning: Use this at your own risk. Recommended to set Bargain to a seperate chat tab to prevent
													clicking accidentally.
												*/
	DELAY_ACTIONS 				= true,			// Simulate human-like response times.
	ACTION_DELAY_LONG_MS		= [3643, 6712],	// [Min, Max]
	ACTION_DELAY_SHORT_MS		= [717, 1348],	// [Min, Max]
	ACTION_DELAY_TIMEOUT_MS		= [22313, 31324],// [Min, Max]
	ACTION_DELAY_TIMEOUT_SHORT_MS=[12432,15236]	// [Min, Max]

const TYPE_NEGOTIATION_PENDING = 35,
	TYPE_NEGOTIATION = 36

module.exports = function AutoNegotiate(dispatch) {
	const command = dispatch.command

	let recentDeals = UNATTENDED_MANUAL_NEGOTIATE ? {} : null,
		pendingDeals = [],
		currentDeal = null,
		currentContract = null,
		actionTimeout = null,
		cancelTimeout = null,
		lastSuggest = {}

	command.add('nretry', () => {
		if(Object.keys(lastSuggest).length)
		{
			command.message("Retrying last deal suggestion...")
			dispatch.toClient('S_TRADE_BROKER_DEAL_SUGGESTED', 1, lastSuggest)
		}
		else
		{
			command.message("No deal to retry")
		}
	})
			
	dispatch.hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, {order: 100, filter: {fake: null}}, event => {
		lastSuggest = event
		// Remove old deals that haven't been processed yet
		for(let i = 0; i < pendingDeals.length; i++) {
			let deal = pendingDeals[i]

			if(deal.playerId == event.playerId && deal.listing == event.listing) pendingDeals.splice(i--, 1)
		}

		if(comparePrice(event.offeredPrice, event.sellerPrice) != 0) {
			pendingDeals.push(event)
			queueNextDeal(true)
			return false
		}
		else if(UNATTENDED_MANUAL_NEGOTIATE) {
			let dealId = event.playerId + '-' + event.listing

			if(recentDeals[dealId]) clearTimeout(recentDeals[dealId].timeout)

			recentDeals[dealId] = event
			recentDeals[dealId].timeout = setTimeout(() => { delete recentDeals[dealId] }, rng(ACTION_DELAY_TIMEOUT_MS))
		}
	})

	dispatch.hook('S_TRADE_BROKER_REQUEST_DEAL_RESULT', 1, event => {
		if(currentDeal) {
			if(!event.ok) endDeal()
			//else {command.message('Deal successful')}
		
			return false
		}
	})

	dispatch.hook('S_TRADE_BROKER_DEAL_INFO_UPDATE', 1, event => {
		if(currentDeal) {
			if(event.buyerStage == 2 && event.sellerStage < 2) {
				let deal = currentDeal

				// This abandoned timeout is not a good design, but it's unlikely that it will cause any issues
				setTimeout(() => {
					if(currentDeal && deal.playerId == currentDeal.playerId && deal.listing == currentDeal.listing && BigInt(event.price) >= BigInt(currentDeal.offeredPrice)) {
						dispatch.toServer('C_TRADE_BROKER_DEAL_CONFIRM', 1, {
							listing: currentDeal.listing,
							stage: event.sellerStage + 1
						})
					}
					else endDeal() // We negotiated the wrong one, whoops! - TODO: Inspect S_REQUEST_CONTRACT.data for price and other info
				}, event.sellerStage == 0 ? rng(ACTION_DELAY_SHORT_MS) : 0)
			}

			return false
		}
	})

	dispatch.hook('S_REQUEST_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = event
			setEndTimeout()
			return false
		}
	})

	dispatch.hook('S_REPLY_REQUEST_CONTRACT', 1, replyOrAccept)
	dispatch.hook('S_ACCEPT_CONTRACT', 1, replyOrAccept)

	dispatch.hook('S_REJECT_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			command.message(currentDeal.name + ' aborted negotiation.')

			// Fix listing becoming un-negotiable (server-side) if the other user aborts the initial dialog
			if(event.type == TYPE_NEGOTIATION_PENDING)
				dispatch.toServer('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
					playerId: currentDeal.playerId,
					listing: currentDeal.listing
				})

			currentContract = null
			endDeal()
			return false
		}
	})

	dispatch.hook('S_CANCEL_CONTRACT', 1, event => {
		if(currentDeal && (event.type == TYPE_NEGOTIATION_PENDING || event.type == TYPE_NEGOTIATION)) {
			currentContract = null
			endDeal()
			return false
		}
	})

	dispatch.hook('S_SYSTEM_MESSAGE', 1, event => {
		if(currentDeal) {
			try {
				const msg = dispatch.parseSystemMessage(event.message)

				//if(msg.id === 'SMT_MEDIATE_DISCONNECT_CANCEL_OFFER_BY_ME' || msg.id === 'SMT_MEDIATE_TRADE_CANCEL_ME') return false
				if(msg.id === 'SMT_MEDIATE_TRADE_CANCEL_OPPONENT')
				{
					command.message(currentDeal.name + ' cancelled negotiation.')
					return false
				}
				else if(msg.id === 'SMT_MEDIATE_SUCCESS_SELL')
				{
					command.message('Deal successful')
				}
		}
			catch(e) {}
		}
	})

	if(UNATTENDED_MANUAL_NEGOTIATE)
		dispatch.hook('C_REQUEST_CONTRACT', 1, event => {
			if(event.type == 35) {
				let deal = recentDeals[event.data.readUInt32LE(0) + '-' + event.data.readUInt32LE(4)]

				if(deal) {
					currentDeal = deal
					command.message('Handling negotiation with ' + currentDeal.name + '...')
					process.nextTick(() => {
						dispatch.toClient('S_REPLY_REQUEST_CONTRACT', 1, { type: event.type })
					})
				}
			}
		})

	function replyOrAccept(event) {
		if(currentDeal && event.type == TYPE_NEGOTIATION_PENDING) {
			setEndTimeout()
			return false
		}
	}

	// 1 = Auto Accept, 0 = No Action, -1 = Auto-decline rng_yes_or_no(AUTO_REJECT_CHANCE)
	function comparePrice(offer, seller) {
		if(AUTO_REJECT_THRESHOLD && rng_yes_or_no(AUTO_REJECT_CHANCE) && BigInt(offer) < (BigInt(seller) * BigInt(AUTO_REJECT_THRESHOLD)) / 100n) return -1
		if(AUTO_REJECT_TROLLS	 && rng_yes_or_no(AUTO_REJECT_CHANCE) && BigInt(offer) > (BigInt(seller) * BigInt(AUTO_REJECT_TROLLS)) / 100n) return -1
		if(AUTO_ACCEPT_THRESHOLD && BigInt(offer) >= (BigInt(seller) * BigInt(AUTO_ACCEPT_THRESHOLD)) / 100n) return 1
		return 0
	}

	function queueNextDeal(slow) {
		if(!actionTimeout && !currentDeal)
			actionTimeout = setTimeout(tryNextDeal, DELAY_ACTIONS ? rng(slow ? ACTION_DELAY_LONG_MS : ACTION_DELAY_SHORT_MS) : 0)
	}

	function tryNextDeal() {
		actionTimeout = null

		if(!(currentDeal = pendingDeals.shift())) return

		if(comparePrice(currentDeal.offeredPrice, currentDeal.sellerPrice) == 1) {
			command.message('Attempting to negotiate with ' + currentDeal.name + '...')
			command.message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			const data = Buffer.alloc(30)
			data.writeUInt32LE(currentDeal.playerId, 0)
			data.writeUInt32LE(currentDeal.listing, 4)

			dispatch.toServer('C_REQUEST_CONTRACT', 1, {
				type: 35,
				unk2: 0,
				unk3: 0,
				unk4: 0,
				name: '',
				data
			})
		}
		else {
			dispatch.toServer('C_TRADE_BROKER_REJECT_SUGGEST', 1, {
				playerId: currentDeal.playerId,
				listing: currentDeal.listing
			})

			command.message('Declined negotiation from ' + currentDeal.name + '.')
			command.message('Price: ' + formatGold(currentDeal.sellerPrice) + ' - Offered: ' + formatGold(currentDeal.offeredPrice))

			currentDeal = null
			queueNextDeal()
		}
	}

	function setEndTimeout() {
		clearTimeout(cancelTimeout)
		cancelTimeout = setTimeout(endDeal, pendingDeals.length ? rng(ACTION_DELAY_TIMEOUT_SHORT_MS) : rng(ACTION_DELAY_TIMEOUT_MS))
						//setTimeout(endDeal, pendingDeals.length ? 15000 : 30000)
	}

	function endDeal() {
		clearTimeout(cancelTimeout)

		if(currentContract) {
			command.message('Negotiation timed out.')

			dispatch.toServer('C_CANCEL_CONTRACT', 1, {
				type: currentContract.type,
				id: currentContract.id
			})
			currentContract = null
			setEndTimeout()
			return
		}

		currentDeal = null
		queueNextDeal()
	}

	function formatGold(gold) {
		gold = gold.toString()

		let str = ''
		if(gold.length > 4) str += '<font color="#ffb033">' + Number(gold.slice(0, -4)).toLocaleString() + 'g</font>'
		if(gold.length > 2) str += '<font color="#d7d7d7">' + gold.slice(-4, -2) + 's</font>'
		str += '<font color="#c87551">' + gold.slice(-2) + 'c</font>'

		return str
	}

	function rng([min, max]) {
		return min + Math.floor(Math.random() * (max - min + 1))
	}
	
	function rng_yes_or_no(chance) {
		return chance > rng([0,100]) ? true : false
	}
}