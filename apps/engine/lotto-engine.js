// Lotto & Reward Engine — PF-10 (Phase E)
// Weekly/Daily lotto rounds: tickets, draw, prize claim
// Based on NB vision (25/06/2023): "Lotto" feature in Basic subscription
// Author: AliClaw | Date: 2026-07-07

class LottoEngine {
  /**
   * @param {Object} deps
   * @param {Object} deps.roundStore
   * @param {Object} deps.ticketStore
   * @param {Object} deps.drawStore
   * @param {Object} deps.memberService - check subscription (Basic+ for lotto_weekly)
   * @param {Object} deps.tokenEngine - deduct ticket price, credit prize
   * @param {Object} deps.auditEngine
   * @param {Object} deps.eventBus
   * @param {Object} deps.rng - crypto-safe random (default Math.random for prototype)
   */
  constructor({ roundStore, ticketStore, drawStore, memberService, tokenEngine, auditEngine, eventBus, rng } = {}) {
    this.rounds = roundStore || new Map();
    this.tickets = ticketStore || new Map();
    this.draws = drawStore || new Map();
    this.members = memberService || { get: async () => null };
    this.tokens = tokenEngine || { credit: async () => ({ txn_id: 'mock' }), debit: async () => ({ txn_id: 'mock' }) };
    this.audit = auditEngine || { log: async () => ({ id: 'mock' }) };
    this.bus = eventBus || { publish: async () => {} };
    this.rng = rng || { nextInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min };
    this._idSeq = 0;
  }

  // ============================================================
  // 1. createRound() — create a new lotto round
  // ============================================================
  async createRound({ merchant_id, token_id, name, ticket_price, max_tickets, prize_pool, draw_at, frequency = 'weekly', required_feature = null, actor = 'admin' }) {
    if (!merchant_id || !token_id || !name || !ticket_price || !max_tickets) {
      throw new Error('merchant_id, token_id, name, ticket_price, max_tickets are required');
    }
    if (ticket_price <= 0) throw new Error('ticket_price must be positive');
    if (max_tickets <= 0) throw new Error('max_tickets must be positive');
    if (!draw_at) throw new Error('draw_at is required');

    const round_id = `LOTTO-${Date.now()}-${++this._idSeq}`;
    const round = {
      round_id,
      merchant_id,
      token_id,
      name,
      ticket_price,
      max_tickets,
      tickets_sold: 0,
      prize_pool: prize_pool || (ticket_price * max_tickets * 0.9), // default 90% to prize
      draw_at: new Date(draw_at).toISOString(),
      frequency,
      required_feature, // e.g., 'lotto_weekly' — only subscribers with this feature can buy
      status: 'open', // open | drawn | claimed | cancelled
      drawn_at: null,
      winning_ticket_id: null,
      created_at: new Date().toISOString(),
    };
    this.rounds.set(round_id, round);

    await this.bus.publish('lotto.round_created', { round_id, name, prize_pool: round.prize_pool, draw_at: round.draw_at });
    await this.audit.log({
      event_type: 'LOTTO_ROUND_CREATED', actor,
      resource_type: 'lotto_round', resource_id: round_id,
      action: 'CREATE',
      metadata: { merchant_id, name, ticket_price, max_tickets, prize_pool: round.prize_pool, draw_at: round.draw_at },
    });

    return round;
  }

  // ============================================================
  // 2. buyTicket() — user buys a ticket
  // ============================================================
  async buyTicket({ round_id, member_id, idempotency_key = null, actor = 'system' }) {
    if (!round_id || !member_id) throw new Error('round_id, member_id are required');

    // Idempotency
    if (idempotency_key) {
      const existing = Array.from(this.tickets.values()).find(
        (t) => t.idempotency_key === idempotency_key
      );
      if (existing) return existing;
    }

    const round = this.rounds.get(round_id);
    if (!round) throw new Error(`Round not found: ${round_id}`);
    if (round.status !== 'open') throw new Error(`Round is ${round.status}`);
    if (round.tickets_sold >= round.max_tickets) throw new Error('Round is sold out');

    // Feature gate (e.g., lotto_weekly requires Basic subscription)
    if (round.required_feature) {
      const member = await this.members.get(member_id);
      if (!member) throw new Error(`Member not found: ${member_id}`);
      if (!member.features || !member.features.includes(round.required_feature)) {
        throw new Error(`This lotto requires "${round.required_feature}" feature (subscription)`);
      }
    }

    // Check duplicate ticket (1 ticket per member per round)
    const existingTicket = Array.from(this.tickets.values()).find(
      (t) => t.round_id === round_id && t.member_id === member_id && t.status !== 'cancelled'
    );
    if (existingTicket) {
      throw new Error(`Member already has ticket for this round: ${existingTicket.ticket_id}`);
    }

    // Charge ticket price
    let debitTxn = null;
    try {
      debitTxn = await this.tokens.debit({
        member_id,
        amount: round.ticket_price,
        source: 'LOTTO_TICKET',
        claim_id: `LOTTO-T-${round_id}-${member_id}-${Date.now()}`,
        metadata: { round_id },
      });
    } catch (e) {
      throw new Error(`Payment failed: ${e.message}`);
    }

    // Generate ticket number (sequential + random suffix for fairness display)
    const ticket_id = `TKT-${Date.now()}-${++this._idSeq}`;
    const ticket_number = round.tickets_sold + 1;
    const lucky_code = this._generateLuckyCode();

    const ticket = {
      ticket_id,
      round_id,
      member_id,
      ticket_number,
      lucky_code,
      price_paid: round.ticket_price,
      debit_txn_id: debitTxn.txn_id,
      idempotency_key,
      status: 'active', // active | won | lost | cancelled
      purchased_at: new Date().toISOString(),
    };
    this.tickets.set(ticket_id, ticket);
    round.tickets_sold++;

    await this.bus.publish('lotto.ticket_purchased', { ticket_id, round_id, member_id, ticket_number });
    await this.audit.log({
      event_type: 'LOTTO_TICKET_PURCHASED', actor,
      resource_type: 'lotto_ticket', resource_id: ticket_id,
      member_id, action: 'CREATE',
      metadata: { round_id, ticket_number, price_paid: round.ticket_price },
    });

    return ticket;
  }

  // ============================================================
  // 3. draw() — pick winner (RNG)
  // ============================================================
  async draw({ round_id, actor = 'system' }) {
    const round = this.rounds.get(round_id);
    if (!round) throw new Error(`Round not found: ${round_id}`);
    if (round.status !== 'open') throw new Error(`Round already ${round.status}`);
    if (round.tickets_sold === 0) throw new Error('No tickets sold, cannot draw');

    // RNG: pick random ticket
    const allTickets = Array.from(this.tickets.values()).filter(
      (t) => t.round_id === round_id && t.status === 'active'
    );
    const winningIdx = this.rng.nextInt(0, allTickets.length - 1);
    const winningTicket = allTickets[winningIdx];

    winningTicket.status = 'won';
    round.status = 'drawn';
    round.drawn_at = new Date().toISOString();
    round.winning_ticket_id = winningTicket.ticket_id;

    // Record draw
    const draw_id = `DRAW-${Date.now()}-${++this._idSeq}`;
    const drawRecord = {
      draw_id,
      round_id,
      winning_ticket_id: winningTicket.ticket_id,
      winning_member_id: winningTicket.member_id,
      total_tickets: allTickets.length,
      prize_amount: round.prize_pool,
      drawn_at: round.drawn_at,
      rng_method: 'uniform_random',
      actor,
    };
    this.draws.set(draw_id, drawRecord);

    // Update all other tickets to 'lost'
    for (const t of allTickets) {
      if (t.ticket_id !== winningTicket.ticket_id) t.status = 'lost';
    }

    await this.bus.publish('lotto.drawn', {
      draw_id, round_id, winning_ticket_id: winningTicket.ticket_id,
      winning_member_id: winningTicket.member_id, prize_amount: round.prize_pool,
    });
    await this.audit.log({
      event_type: 'LOTTO_DRAWN', actor,
      resource_type: 'lotto_round', resource_id: round_id,
      action: 'UPDATE',
      metadata: { draw_id, winning_ticket_id: winningTicket.ticket_id, prize: round.prize_pool, total_tickets: allTickets.length },
    });

    return drawRecord;
  }

  // ============================================================
  // 4. claimPrize() — winner claims the prize
  // ============================================================
  async claimPrize({ draw_id, actor = 'system' }) {
    const draw = this.draws.get(draw_id);
    if (!draw) throw new Error(`Draw not found: ${draw_id}`);
    if (draw.claimed) return { status: 'ALREADY_CLAIMED' };

    const ticket = this.tickets.get(draw.winning_ticket_id);
    if (!ticket) throw new Error('Winning ticket not found');

    const round = this.rounds.get(draw.round_id);

    // Credit prize to winner
    const credit = await this.tokens.credit({
      member_id: draw.winning_member_id,
      amount: draw.prize_amount,
      source: 'LOTTO_PRIZE',
      claim_id: `LOTTO-PRIZE-${draw_id}`,
      metadata: { round_id: draw.round_id, draw_id },
    });

    draw.claimed = true;
    draw.claimed_at = new Date().toISOString();
    draw.credit_txn_id = credit.txn_id;
    ticket.status = 'claimed';
    round.status = 'claimed';

    await this.bus.publish('lotto.prize_claimed', {
      draw_id, member_id: draw.winning_member_id, amount: draw.prize_amount,
    });
    await this.audit.log({
      event_type: 'LOTTO_PRIZE_CLAIMED', actor,
      resource_type: 'lotto_draw', resource_id: draw_id,
      member_id: draw.winning_member_id, action: 'CREATE',
      metadata: { amount: draw.prize_amount, credit_txn_id: credit.txn_id },
    });

    return { status: 'CLAIMED', amount: draw.prize_amount, credit_txn_id: credit.txn_id, member_id: draw.winning_member_id };
  }

  // ============================================================
  // 5. listRounds() / getRound()
  // ============================================================
  async listRounds({ merchant_id, status, frequency, limit = 50 } = {}) {
    let all = Array.from(this.rounds.values());
    if (merchant_id) all = all.filter((r) => r.merchant_id === merchant_id);
    if (status) all = all.filter((r) => r.status === status);
    if (frequency) all = all.filter((r) => r.frequency === frequency);
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  async getRound(round_id) {
    const round = this.rounds.get(round_id);
    if (!round) throw new Error(`Round not found: ${round_id}`);
    return round;
  }

  // ============================================================
  // 6. listTickets() — for member's history
  // ============================================================
  async listTickets({ member_id, round_id, status, limit = 100 } = {}) {
    let all = Array.from(this.tickets.values());
    if (member_id) all = all.filter((t) => t.member_id === member_id);
    if (round_id) all = all.filter((t) => t.round_id === round_id);
    if (status) all = all.filter((t) => t.status === status);
    all.sort((a, b) => b.purchased_at.localeCompare(a.purchased_at));
    return { total: all.length, items: all.slice(0, limit) };
  }

  // ============================================================
  // 7. getStats() — for admin dashboard
  // ============================================================
  async getStats({ merchant_id, since } = {}) {
    const sinceMs = since ? new Date(since).getTime() : 0;
    let rounds = Array.from(this.rounds.values());
    if (merchant_id) rounds = rounds.filter((r) => r.merchant_id === merchant_id);
    const recentRounds = rounds.filter((r) => new Date(r.created_at).getTime() >= sinceMs);

    const draws = Array.from(this.draws.values()).filter(
      (d) => new Date(d.drawn_at).getTime() >= sinceMs
    );
    const totalPrize = draws.reduce((s, d) => s + d.prize_amount, 0);
    const tickets = Array.from(this.tickets.values()).filter(
      (t) => new Date(t.purchased_at).getTime() >= sinceMs
    );
    const totalRevenue = tickets.reduce((s, t) => s + t.price_paid, 0);

    return {
      rounds_total: rounds.length,
      rounds_recent: recentRounds.length,
      draws_count: draws.length,
      tickets_sold: tickets.length,
      total_revenue: totalRevenue,
      total_prize: totalPrize,
      net_revenue: totalRevenue - totalPrize,
    };
  }

  // ============================================================
  // private
  // ============================================================
  _generateLuckyCode() {
    // 6-digit number, zero-padded
    return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LottoEngine };
}
if (typeof window !== 'undefined') {
  window.LottoEngine = LottoEngine;
}
