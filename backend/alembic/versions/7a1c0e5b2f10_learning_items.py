"""learning items (video / reading content)

Revision ID: 7a1c0e5b2f10
Revises: 2d9c39f433b0
"""
from alembic import op
import sqlalchemy as sa

revision = '7a1c0e5b2f10'
down_revision = '2d9c39f433b0'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('learning_items',
                    sa.Column('id', sa.String(length=32), nullable=False),
                    sa.Column('course_id', sa.String(length=32), sa.ForeignKey('courses.id'), nullable=False),
                    sa.Column('module_id', sa.String(length=32), nullable=True),
                    sa.Column('type', sa.String(length=16), nullable=False),
                    sa.Column('title', sa.String(length=300), nullable=False),
                    sa.Column('presenter', sa.String(length=32), sa.ForeignKey('avatars.id'), nullable=True),
                    sa.Column('content', sa.JSON(), nullable=False),
                    sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
                    sa.Column('digest', sa.String(length=64), nullable=False, server_default=''),
                    sa.Column('status', sa.String(length=16), nullable=False, server_default='published'),
                    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
                    sa.PrimaryKeyConstraint('id'))
    op.create_index('ix_learning_items_course_id', 'learning_items', ['course_id'])


def downgrade():
    op.drop_index('ix_learning_items_course_id', table_name='learning_items')
    op.drop_table('learning_items')
