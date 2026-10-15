/**
 * 认证服务：微信登录 → 建立/查找用户 → 签发 token
 */
const axios = require('axios');
const crypto = require('crypto');
const db = require('../models/db');
const config = require('../config');
const logger = require('../utils/logger');
const { sign } = require('../middlewares/auth');

/**
 * 微信 code 换 openid
 */
async function code2session(code) {
  const { data } = await axios.get(config.wx.code2sessionUrl, {
    params: {
      appid: config.wx.appid,
      secret: config.wx.secret,
      js_code: code,
      grant_type: 'authorization_code',
    },
    timeout: 8000,
  });

  if (data.errcode) {
    logger.warn({ errcode: data.errcode, errmsg: data.errmsg }, 'code2session 失败');
    const e = new Error('微信登录失败：' + (data.errmsg || '未知错误'));
    e.code = 4001;
    throw e;
  }
  return { openid: data.openid, unionid: data.unionid || null };
}

/** 生成不易碰撞的邀请码 */
function genInviteCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

/**
 * 登录/注册
 * @param {string} code 微信 code
 * @param {number} role 1=孩子 2=家长
 */
async function login(code, role = 1) {
  const { openid, unionid } = await code2session(code);

  const [rows] = await db.query(
    'SELECT * FROM user WHERE openid = ? AND status = 1 LIMIT 1',
    [openid]
  );

  let user;
  if (rows.length) {
    user = rows[0];
    // 角色可变（同一微信号既是家长也可能是孩子）
    if (Number(user.role) !== Number(role)) {
      await db.query('UPDATE user SET role = ? WHERE id = ?', [role, user.id]);
      user.role = role;
    }
  } else {
    const res = await db.query(
      `INSERT INTO user (openid, unionid, role, nickname)
       VALUES (?, ?, ?, ?)`,
      [openid, unionid, role, role === 2 ? '家长' : '小朋友']
    );
    const [created] = await db.query('SELECT * FROM user WHERE id = ?', [res.insertId]);
    user = created[0];
    logger.info({ uid: user.id, role }, '新用户注册');
  }

  const token = sign({ uid: user.id, role: user.role });
  return { token, user: publicUser(user) };
}

/** 过滤敏感字段 */
function publicUser(u) {
  return {
    uid: Number(u.id),
    role: Number(u.role),
    nickname: u.nickname,
    avatarUrl: u.avatar_url,
    grade: u.grade,
    familyId: u.family_id ? Number(u.family_id) : null,
    textbookId: u.textbook_id ? Number(u.textbook_id) : null,
    lessonProgress: u.lesson_progress,
  };
}

async function getProfile(uid) {
  const [rows] = await db.query('SELECT * FROM user WHERE id = ? AND status = 1', [uid]);
  if (!rows.length) {
    const e = new Error('用户不存在');
    e.code = 4040;
    throw e;
  }
  return publicUser(rows[0]);
}

async function updateProfile(uid, { nickname, avatarUrl, grade, textbookId, lessonProgress }) {
  const fields = [];
  const params = [];
  if (nickname !== undefined) { fields.push('nickname = ?'); params.push(nickname); }
  if (avatarUrl !== undefined) { fields.push('avatar_url = ?'); params.push(avatarUrl); }
  if (grade !== undefined) { fields.push('grade = ?'); params.push(grade); }
  if (textbookId !== undefined) { fields.push('textbook_id = ?'); params.push(textbookId); }
  if (lessonProgress !== undefined) { fields.push('lesson_progress = ?'); params.push(lessonProgress); }

  if (fields.length) {
    params.push(uid);
    await db.query(`UPDATE user SET ${fields.join(', ')} WHERE id = ?`, params);
  }
  return getProfile(uid);
}

/**
 * 孩子生成邀请码，供家长扫码绑定
 */
async function getInviteCode(uid) {
  const [rows] = await db.query('SELECT * FROM user WHERE id = ?', [uid]);
  if (!rows.length) {
    const e = new Error('用户不存在');
    e.code = 4040;
    throw e;
  }
  const user = rows[0];

  if (user.family_id) {
    const [f] = await db.query('SELECT invite_code FROM family WHERE id = ?', [user.family_id]);
    if (f.length) return { inviteCode: f[0].invite_code };
  }

  // 没有家庭则创建
  const inviteCode = genInviteCode();
  const res = await db.query('INSERT INTO family (invite_code) VALUES (?)', [inviteCode]);
  await db.query('UPDATE user SET family_id = ? WHERE id = ?', [res.insertId, uid]);
  return { inviteCode };
}

/**
 * 家长凭邀请码绑定
 */
async function bindFamily(parentUid, inviteCode) {
  const [f] = await db.query('SELECT * FROM family WHERE invite_code = ? LIMIT 1', [
    String(inviteCode).toUpperCase(),
  ]);
  if (!f.length) {
    const e = new Error('邀请码无效');
    e.code = 4000;
    throw e;
  }
  await db.query('UPDATE user SET family_id = ? WHERE id = ?', [f[0].id, parentUid]);
  logger.info({ parentUid, familyId: f[0].id }, '家长绑定成功');
  return { familyId: Number(f[0].id) };
}

/** 查询家长绑定的孩子 */
async function listChildren(parentUid) {
  const [me] = await db.query('SELECT family_id FROM user WHERE id = ?', [parentUid]);
  if (!me.length || !me[0].family_id) return [];
  const [kids] = await db.query(
    `SELECT id, nickname, avatar_url, grade FROM user
      WHERE family_id = ? AND role = 1 AND status = 1`,
    [me[0].family_id]
  );
  return kids.map((k) => ({
    uid: Number(k.id),
    nickname: k.nickname,
    avatarUrl: k.avatar_url,
    grade: k.grade,
  }));
}

module.exports = {
  login,
  getProfile,
  updateProfile,
  getInviteCode,
  bindFamily,
  listChildren,
  publicUser,
  code2session,
};
