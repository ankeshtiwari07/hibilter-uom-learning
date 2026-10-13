import redis.asyncio as aioredis

from .config import get_settings

_r = None


def redis():
    global _r
    if _r is None:
        _r = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _r


async def hit(key: str, limit: int, window_s: int = 60) -> bool:
    """Returns True when the call is allowed. Fails open if Redis is unavailable."""
    try:
        r = redis()
        n = await r.incr(key)
        if n == 1:
            await r.expire(key, window_s)
        return n <= limit
    except Exception:
        return True
