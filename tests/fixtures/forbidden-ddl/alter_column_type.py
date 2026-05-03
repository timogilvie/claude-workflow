revision = "005"
down_revision = "004"

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.alter_column("widgets", "count", type_=sa.BigInteger())


def downgrade():
    pass
