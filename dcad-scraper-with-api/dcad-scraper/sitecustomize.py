import sys, asyncio
if sys.platform.startswith('win'):
    # Ensure Playwright can spawn subprocesses on Windows
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
