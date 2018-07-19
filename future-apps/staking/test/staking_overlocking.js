const { assertRevert } = require('@aragon/test-helpers/assertThrow')
const { encodeCallScript } = require('@aragon/test-helpers/evmScript')

const getContract = artifacts.require
const getEvent = (receipt, event, arg) => { return receipt.logs.filter(l => l.event == event)[0].args[arg] }

contract('Staking app, overlocking', accounts => {
  let app, token
  const owner = accounts[0]
  const other = accounts[1]
  const balance = 1000

  const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000"
  let ANY_ENTITY
  const TIME_UNIT_BLOCKS = 0
  const TIME_UNIT_SECONDS = 1
  const OVERLOCKING = true

  const amount = 100

  beforeEach(async () => {
    app = await getContract('StakingMock').new()
    ANY_ENTITY = await app.ANY_ENTITY.call()
    token = await getContract('StandardTokenMock').new(owner, balance)
    // allow Staking app to move owner tokens
    await token.approve(app.address, amount)
    // init Staking
    await app.initialize(OVERLOCKING, token.address, '', '', '')
  })

  it('has correct initial state', async () => {
    assert.equal(await app.token.call(), token.address, "Token is wrong")
    assert.equal((await app.totalStaked.call()).valueOf(), 0, "Initial total staked amount should be zero")
    assert.isFalse(await app.supportsHistory.call(), "Shouldn't support history")
    assert.isTrue(await app.overlocking.call(), "Should support overlocking")
  })

  it('unstakes after overlocking', async () => {
    const initialOwnerBalance = parseInt((await token.balanceOf.call(owner)).valueOf(), 10)
    const initialStakingBalance = parseInt((await token.balanceOf.call(app.address)).valueOf(), 10)

    // stake tokens
    await app.stake(amount, '')
    // lock twice
    const r1 = await app.lockIndefinitely(amount / 2, other, '', '')
    const lockId1 = getEvent(r1, 'Locked', 'lockId')
    const r2 = await app.lockIndefinitely(amount, other, '', '')
    const lockId2 = getEvent(r2, 'Locked', 'lockId')
    // can not unstake
    await assertRevert(async () => {
      await app.unstake(amount / 2, '')
    })
    // unlock 2nd lock
    await app.unlock(owner, lockId2, { from: other })
    // now we can unstake half of them
    await app.unstake(amount / 2, '')

    const finalOwnerBalance = parseInt((await token.balanceOf.call(owner)).valueOf(), 10)
    const finalStakingBalance = parseInt((await token.balanceOf.call(app.address)).valueOf(), 10)
    assert.equal(finalOwnerBalance, initialOwnerBalance - amount / 2, "owner balance should match")
    assert.equal(finalStakingBalance, initialStakingBalance + amount / 2, "Staking app balance should match")
    assert.equal((await app.totalStakedFor.call(owner)).valueOf(), amount / 2, "staked value should match")

    // the other haf is still locked, so can not unstake it
    await assertRevert(async () => {
      await app.unstake(amount / 2, '')
    })
  })

  it('locks indefinitely', async () => {
    await app.stake(amount, '')
    const r = await app.lockIndefinitely(amount / 2, other, '', '')
    const lockId = getEvent(r, 'Locked', 'lockId')
    // can not unlock
    assert.isFalse(await app.canUnlock.call(owner, lockId))
    await app.setTimestamp((await app.getTimestampExt.call()) + 5000)
    // still the same, can not unlock
    assert.isFalse(await app.canUnlock.call(owner, lockId))
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    assert.equal((await app.locksCount.call(owner)).valueOf(), parseInt(lockId, 10) + 1, "last lock id should match")
  })

  it('locks already locked tokens (overlocking)', async () => {
    await app.stake(amount, '')
    // lock twice
    const r1 = await app.lockIndefinitely(amount / 2, other, '', '')
    const lockId1 = getEvent(r1, 'Locked', 'lockId')
    const r2 = await app.lockIndefinitely(amount / 2 + 1, other, '', '')
    const lockId2 = getEvent(r2, 'Locked', 'lockId')
    // checks
    assert.notEqual(lockId1, lockId2, "Lock Ids should be different")
    // only biggest one counts
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2 - 1, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    assert.equal((await app.locksCount.call(owner)).valueOf(), parseInt(lockId2, 10) + 1, "last lock id should match")
  })

  it('locks using seconds', async () => {
    const time = 1000
    await app.stake(amount, '')
    const startTime = await app.getTimestampExt.call()
    const endTime = startTime + time
    const r = await app.lockNow(amount / 2, TIME_UNIT_SECONDS, endTime, other, '', '')
    const lockId = getEvent(r, 'Locked', 'lockId')

    // check lock values
    const lock = await app.getLock.call(owner, lockId)
    assert.equal(lock[0], amount / 2, "locked amount should match")
    assert.equal(lock[1], TIME_UNIT_SECONDS, "lock time unit should match")
    assert.equal(lock[2].toString(), startTime, "lock time start should match")
    assert.equal(lock[3], endTime, "lock time end should match")
    assert.equal(lock[4], other, "unlocker should match")
    assert.equal(lock[5], zeroBytes32, "lock metadata should match")
    assert.equal(lock[6], 0, "next lock id should match")

    // can not unlock
    assert.isFalse(await app.canUnlock.call(owner, lockId))
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    assert.equal((await app.locksCount.call(owner)).valueOf(), parseInt(lockId, 10) + 1, "last lock id should match")

    await app.setTimestamp(endTime + 1)
    // can unlock
    assert.isTrue(await app.canUnlock.call(owner, lockId))
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")

  })

  it('locks using blocks', async () => {
    const blocks = 2
    await app.stake(amount, '')
    const startBlock = await app.getBlockNumberExt.call.call()
    const endBlock = startBlock + blocks
    const r = await app.lockNow(amount / 2, TIME_UNIT_BLOCKS, endBlock, other, '', '')
    const lockId = getEvent(r, 'Locked', 'lockId')

    // check lock values
    const lock = await app.lastLock.call(owner)
    assert.equal(lock[0], amount / 2, "locked amount should match")
    assert.equal(lock[1], TIME_UNIT_BLOCKS, "lock time unit should match")
    assert.equal(lock[2].toString(), startBlock, "start block lock  should match")
    assert.equal(lock[3], endBlock, "end block end should match")
    assert.equal(lock[4], other, "unlocker should match")
    assert.equal(lock[5], "0x0000000000000000000000000000000000000000000000000000000000000000", "lock metadata should match")
    assert.equal(lock[6], 0, "next lock id should match")

    // can not unlock
    assert.isFalse(await app.canUnlock.call(owner, lockId))
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    assert.equal((await app.locksCount.call(owner)).valueOf(), parseInt(lockId, 10) + 1, "last lock id should match")

    await app.setBlockNumber(endBlock + 1)
    // can unlock
    assert.isTrue(await app.canUnlock.call(owner, lockId))
  })


  it('unlocks partially', async () => {
    const time = 1000
    await app.stake(amount, '')
    const endTime = (await app.getTimestampExt.call()) + time
    const r = await app.lockNow(amount / 2, TIME_UNIT_SECONDS, endTime, other, '', '')
    const lockId = getEvent(r, 'Locked', 'lockId')

    // unlock
    await app.unlockPartial(owner, lockId, amount / 4, { from: other })

    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount * 3 / 4, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    assert.equal((await app.locksCount.call(owner)).valueOf(), 2, "there should still be 1 lock") // id 0 is left empty

    // unlocks again
    await app.unlockPartial(owner, lockId, amount / 4, { from: other })

    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount, "Unlocked balance should match")
    // lock doesn't count for the unlocker as overlocing is enabled
    assert.equal((await app.unlockedBalanceOf.call(owner, other)).valueOf(), amount, "Unlocked balance should match for unlocker")
    // TODO assert.equal((await app.locksCount.call(owner)).valueOf(), 1, "there shouldn't be locks") // id 0 is left empty
  })

  it('moves tokens', async () => {
    const time = 1000
    await app.stake(amount, '')
    await app.moveTokens(owner, other, amount / 2)
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked owner balance should match")
    assert.equal((await app.unlockedBalanceOf.call(other, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked other balance should match")
  })

  it('fails moving more tokens than unlocked', async () => {
    await app.stake(amount, '')
    await app.lockIndefinitely(amount / 2, other, '', '')
    return assertRevert(async () => {
      await app.moveTokens(owner, other, amount / 2 + 1)
    })
  })

  it('moves tokens after overlocking', async () => {
    // stake tokens
    await app.stake(amount, '')
    // lock twice
    const r1 = await app.lockIndefinitely(amount / 2, other, '', '')
    const lockId1 = getEvent(r1, 'Locked', 'lockId')
    const r2 = await app.lockIndefinitely(amount, other, '', '')
    const lockId2 = getEvent(r2, 'Locked', 'lockId')
    // can not move
    await assertRevert(async () => {
      await app.moveTokens(owner, other, amount / 2)
    })
    // unlock 2nd lock
    await app.unlock(owner, lockId2, { from: other })
    // now we can move half of them
    await app.moveTokens(owner, other, amount / 2)
    // checks
    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), 0, "Unlocked owner balance should match")
    assert.equal((await app.unlockedBalanceOf.call(other, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked other balance should match")

    // the other haf is still locked, so can not be moved
    await assertRevert(async () => {
      await app.moveTokens(owner, other, amount / 2)
    })
  })

  it('unlocks and moves tokens', async () => {
    const time = 1000
    await app.stake(amount, '')
    const endTime = (await app.getTimestampExt.call()) + time
    const r = await app.lockNow(amount / 2, TIME_UNIT_SECONDS, endTime, other, '', '')
    const lockId = getEvent(r, 'Locked', 'lockId')

    // unlock
    await app.unlockPartialAndMoveTokens(owner, lockId, other, amount / 4, { from: other })

    assert.equal((await app.unlockedBalanceOf.call(owner, ANY_ENTITY)).valueOf(), amount / 2, "Unlocked owner balance should match")
    assert.equal((await app.locksCount.call(owner)).valueOf(), 2, "there should still be 1 lock") // id 0 is left empty
    assert.equal((await app.unlockedBalanceOf.call(other, ANY_ENTITY)).valueOf(), amount / 4, "Unlocked other balance should match")
  })
})