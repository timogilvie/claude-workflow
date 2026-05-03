revision = "007"
down_revision = "006"

from alembic import op


def upgrade():
    op.execute("UPDATE widgets SET count = count + 1")


def downgrade():
    pass
