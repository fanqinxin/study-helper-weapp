/**
 * 额度与订单路由
 */
const express = require('express');
const quota = require('../services/quota');
const config = require('../config');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');

const router = express.Router();

/** 查询余额 */
router.get(
  '/quota/balance',
  auth,
  wrap(async (req, res) => ok(res, await quota.getBalance(req.uid)))
);

/** 加油包档位 */
router.get(
  '/quota/packs',
  auth,
  wrap(async (req, res) => {
    ok(res, {
      packs: config.packs.map((p) => ({
        packId: p.packId,
        title: p.title,
        desc: p.desc,
        amountFen: p.amountFen,
        quota: p.quota,
        recommended: !!p.recommended,
        monthly: !!p.monthly,
      })),
    });
  })
);

/** 额度流水 */
router.get(
  '/quota/logs',
  auth,
  wrap(async (req, res) => {
    const { page = 1, size = 20 } = req.query;
    ok(res, await quota.getLogs(req.uid, { page: Number(page), size: Number(size) }));
  })
);

/**
 * 创建订单
 * 说明：微信支付下单在 Phase 4 接入，这里先返回订单信息，
 * 支付参数由 wxpay 服务生成后再补。
 */
router.post(
  '/order/create',
  auth,
  wrap(async (req, res) => {
    const allow = await rateLimit(`order:${req.uid}`, 10, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '操作过于频繁');

    const { packId } = req.body || {};
    const pack = config.packs.find((p) => p.packId === packId);
    if (!pack) return fail(res, CODES.BAD_REQUEST, '加油包不存在');

    // TODO(Phase 4): 调用微信支付统一下单，返回 prepay_id 等参数
    ok(res, {
      packId: pack.packId,
      amountFen: pack.amountFen,
      msg: '微信支付待接入（Phase 4）',
    });
  })
);

module.exports = router;
