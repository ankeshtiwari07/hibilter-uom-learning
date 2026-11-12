"""webinar email: campaigns, outbox, newsletter unsubscribe

Revision ID: e7a2b9c4d013
Revises: d5f1a7c3e902
"""
from alembic import op
import sqlalchemy as sa

revision = 'e7a2b9c4d013'
down_revision = 'd5f1a7c3e902'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('webinar_registrations', sa.Column('unsubscribed_at', sa.DateTime(timezone=True)))
    op.create_table(
        'email_campaigns',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('webinar_id', sa.String(48), sa.ForeignKey('webinars.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('kind', sa.String(24), nullable=False),
        sa.Column('edition', sa.String(24)),
        sa.Column('subject', sa.String(200), nullable=False),
        sa.Column('content', sa.JSON, nullable=False, server_default='{}'),
        sa.Column('status', sa.String(16), nullable=False, server_default='draft'),
        sa.Column('created_by', sa.String(200)),
        sa.Column('approved_by', sa.String(200)),
        sa.Column('approved_at', sa.DateTime(timezone=True)),
        sa.Column('recipients', sa.Integer, nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        'email_messages',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('campaign_id', sa.String(32), sa.ForeignKey('email_campaigns.id', ondelete='CASCADE'), index=True),
        sa.Column('registration_id', sa.String(32), index=True),
        sa.Column('kind', sa.String(24), nullable=False),
        sa.Column('to_email', sa.String(200), nullable=False),
        sa.Column('subject', sa.String(200), nullable=False),
        sa.Column('html', sa.Text, nullable=False),
        sa.Column('text', sa.Text, nullable=False),
        sa.Column('headers', sa.JSON, nullable=False, server_default='{}'),
        sa.Column('status', sa.String(16), nullable=False, server_default='queued', index=True),
        sa.Column('attempts', sa.Integer, nullable=False, server_default='0'),
        sa.Column('next_attempt_at', sa.DateTime(timezone=True)),
        sa.Column('error', sa.Text),
        sa.Column('sent_at', sa.DateTime(timezone=True)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('campaign_id', 'to_email', name='uq_campaign_email'),
    )


def downgrade():
    op.drop_table('email_messages')
    op.drop_table('email_campaigns')
    op.drop_column('webinar_registrations', 'unsubscribed_at')
