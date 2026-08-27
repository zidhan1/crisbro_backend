const now = new Date();

const DEFAULT_POINT_REWARD = 4;
const DEFAULT_POINT_GIVEN = 3;
const DEFAULT_EXPIRES_TIME = new Date(now.setMonth(now.getMonth() + 6));

module.exports = {
  DEFAULT_EXPIRES_TIME,
  DEFAULT_POINT_REWARD,
  DEFAULT_POINT_GIVEN,
};
