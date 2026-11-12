"""public webinars + registrations; seeds the AI x Quantum webinar

Revision ID: d5f1a7c3e902
Revises: 9b3d2e7c4a11
"""
from alembic import op
import sqlalchemy as sa

revision = 'd5f1a7c3e902'
down_revision = '9b3d2e7c4a11'
branch_labels = None
depends_on = None

TS = lambda: sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)  # noqa: E731


def upgrade():
    w = op.create_table(
        'webinars',
        sa.Column('id', sa.String(48), primary_key=True),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('presenters', sa.String(200), nullable=False, server_default=''),
        sa.Column('kicker', sa.String(80), nullable=False, server_default='LIVE WEBINAR'),
        sa.Column('summary', sa.Text, nullable=False, server_default=''),
        sa.Column('when_text', sa.String(120), nullable=False, server_default='Date & time to be announced'),
        sa.Column('starts_at', sa.DateTime(timezone=True)),
        sa.Column('duration_min', sa.Integer, nullable=False, server_default='60'),
        sa.Column('where_text', sa.String(120), nullable=False, server_default='Online'),
        sa.Column('join_url', sa.String(500)),
        sa.Column('status', sa.String(16), nullable=False, server_default='open'),
        sa.Column('capacity', sa.Integer),
        sa.Column('meta', sa.JSON, nullable=False, server_default='{}'),
        TS(),
    )
    op.create_table(
        'webinar_registrations',
        sa.Column('id', sa.String(32), primary_key=True),
        sa.Column('webinar_id', sa.String(48), sa.ForeignKey('webinars.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('ref', sa.String(16), nullable=False, unique=True),
        sa.Column('name', sa.String(200), nullable=False),
        sa.Column('email', sa.String(200), nullable=False),
        sa.Column('phone', sa.String(32)),
        sa.Column('role', sa.String(24), nullable=False),
        sa.Column('institution', sa.String(200), nullable=False),
        sa.Column('programme', sa.String(120)),
        sa.Column('year_of_study', sa.String(24)),
        sa.Column('city', sa.String(120)),
        sa.Column('question', sa.Text),
        sa.Column('source', sa.String(48), nullable=False, server_default='direct'),
        sa.Column('utm', sa.JSON, nullable=False, server_default='{}'),
        sa.Column('consent_updates', sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column('status', sa.String(16), nullable=False, server_default='registered'),
        sa.Column('notes', sa.Text),
        sa.Column('updated_at', sa.DateTime(timezone=True)),
        sa.Column('ip_hash', sa.String(64)),
        sa.Column('user_agent', sa.String(300)),
        TS(),
        sa.UniqueConstraint('webinar_id', 'email', name='uq_webinar_email'),
    )
    op.create_index('ix_webinar_reg_created', 'webinar_registrations', ['webinar_id', 'created_at'])
    op.bulk_insert(w, [{
        'id': 'ai-quantum-2026',
        'title': 'The True Potential of AI and Quantum Computing',
        'presenters': 'Hibilter IT Systems & TuQuant present',
        'kicker': 'LIVE WEBINAR',
        'summary': 'What happens when artificial intelligence meets quantum computing? Discover how the two could change how we '
                   'discover medicines, model our climate, protect our data and manage our money — delivered by expert faculty, '
                   'brought to life as AI lecturers who teach, explain and answer your questions.',
        'when_text': 'Date & time announcing soon',
        'duration_min': 60,
        'where_text': 'Online',
        'status': 'open',
        'meta': {
            'tracks': ['MBA · BFSI', 'MBA · Retail Management', 'MBA · Data Science', 'MBA · Artificial Intelligence', 'MBA · Finance'],
            'videos': {'general': '/media/webinar/ai-quantum-2026/invite.mp4', 'mba': '/media/webinar/ai-quantum-2026/invite-mba.mp4'},
            'posters': {'general': '/media/webinar/ai-quantum-2026/poster.jpg', 'mba': '/media/webinar/ai-quantum-2026/poster-mba.jpg'},
            'ref_prefix': 'AQ',
        },
    }])


def downgrade():
    op.drop_index('ix_webinar_reg_created', 'webinar_registrations')
    op.drop_table('webinar_registrations')
    op.drop_table('webinars')
