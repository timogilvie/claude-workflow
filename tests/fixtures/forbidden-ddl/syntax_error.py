revision = "011"
down_revision = "010"

from alembic import op


def upgrade()
    op.drop_table("broken")


def downgrade():
    pass
