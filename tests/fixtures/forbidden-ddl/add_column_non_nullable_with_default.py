revision = "002"
down_revision = "001"

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.add_column("widgets", sa.Column("slug", sa.String(), nullable=False, server_default=""))


def downgrade():
    pass
