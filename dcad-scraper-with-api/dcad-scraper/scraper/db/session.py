import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
def get_engine():
    url = os.environ["DATABASE_URL"]
    return create_engine(url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)
