revision = "001"
down_revision = None

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.add_column("widgets", sa.Column("slug", sa.String(), nullable=False))


def downgrade():
    pass
