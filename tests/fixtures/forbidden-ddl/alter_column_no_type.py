revision = "006"
down_revision = "005"

from alembic import op


def upgrade():
    op.alter_column("widgets", "count", nullable=True)


def downgrade():
    pass
