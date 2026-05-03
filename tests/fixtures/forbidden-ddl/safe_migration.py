revision = "010"
down_revision = "009"

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.add_column("widgets", sa.Column("nickname", sa.String(), nullable=True))


def downgrade():
    pass
