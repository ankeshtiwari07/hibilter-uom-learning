"""trial (customer demo) accounts: users.expires_at, users.acts_for

Revision ID: 9b3d2e7c4a11
Revises: 7a1c0e5b2f10
"""
from alembic import op
import sqlalchemy as sa

revision = '9b3d2e7c4a11'
down_revision = '7a1c0e5b2f10'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('acts_for', sa.String(length=32), nullable=True))


def downgrade():
    op.drop_column('users', 'acts_for')
    op.drop_column('users', 'expires_at')
